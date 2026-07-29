// Den INBÄDDADE 3B-instruct-servern. Instruct-lanen går hit.
//
// Samma konstruktion som localServer.ts (1.5B/FIM) och med flit inte en ny:
// llama.cpp-server som barnprocess, 127.0.0.1, härledd API-nyckel, --no-webui.
// Sökvägar, nyckel och /props-proben kommer ur runtimeLayout.ts, så de två
// lanerna kan inte hamna på olika konventioner. Läs kommentarerna där.
//
// TRE SAKER SKILJER DEN HÄR FRÅN 1.5B-LANEN:
//
//   1. EGEN PORT (11436). 11434 är Ollamas, 11435 är FIM-lanens. Tre lager
//      trafik på samma port hade betytt att en /infill råkade landa i
//      instruct-modellen -- vilket ger nonsens, inte ett fel.
//
//   2. ON-DEMAND. 1.5B:n startas vid uppstart för att autocomplete ska vara
//      varm från första tangenttryck. 3B:n startas vid FÖRSTA instruct-anropet.
//      Skälet är minne: 1.5B (940 MB) + 3B (2,0 GB) residenta samtidigt på en
//      8 GB-maskin lämnar inte plats åt editorn. Instruct-anrop är sällsynta
//      och användarinitierade, så ~4 s uppstart första gången är rätt pris.
//
//   3. IDLE-UNLOAD. Efter ~5 minuters tystnad rivs processen och minnet går
//      tillbaka till maskinen. Nästa anrop startar den igen. FIM-lanen gör
//      INTE det: den fyrar flera gånger i minuten och skulle bara ladda om.
import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import {
  derivedApiKey,
  findRuntime,
  portListening,
  probeReady,
} from "./runtimeLayout.js";

export interface InstructEndpoint {
  /** t.ex. http://127.0.0.1:11436 */
  readonly baseUrl: string;
  /** Skickas som Authorization: Bearer. */
  readonly apiKey: string;
  /** Filnamnet på GGUF:en, för loggar och statusrad. */
  readonly modelName: string;
}

/** Modellmappen som hör till instruct-lanen. FIM-lanens är "model". */
const MODEL_SUBDIR = "model-instruct";

/**
 * 3B laddar långsammare än 1.5B och kallstarten sker medan användaren väntar
 * på ett svar, så taket är generösare än FIM-lanens 60 s.
 */
const HEALTH_TIMEOUT_MS = 90_000;

/** Standardtystnad innan modellen släpps ur minnet. */
const DEFAULT_IDLE_UNLOAD_MS = 5 * 60_000;

/**
 * Hur länge vi ger en FRÄMMANDE server på vår port chansen att visa sig vara
 * vår. Se waitForForeignServer() för varför det är sekunder och inte minuter.
 */
const FOREIGN_SERVER_GRACE_MS = 5_000;

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

export function instructPort(): number {
  const port = cfg().get<number>("instruct.port") ?? 11436;
  // `?? 11436` fångar bara att inställningen SAKNAS. Ett handredigerat
  // settings.json kan innehålla 0, -1, 70000 eller "11436" som sträng, och då
  // hade vi byggt en URL som http://127.0.0.1:0 och väntat ut hela
  // hälsokontrollen på något som aldrig kan svara. Port 0 är särskilt lömsk:
  // llama-server tar då en slumpmässig ledig port och startar helt normalt,
  // medan vi ringer :0.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return 11436;
  }
  // Kollisionerna är inte hypotetiska: 11434 är Ollamas och 11435 är vår egen
  // FIM-server. Bättre att tyst gå tillbaka till 11436 än att låta någon peka
  // hit av misstag.
  //
  // RÄTTELSE av vad som stod här: följden av en krock är INTE att vi "pratar
  // med fel modell och får svar som ser rimliga ut men inte är det". Det kan
  // inte hända, och det är den härledda API-nyckelns förtjänst -- en annan
  // server har en annan nyckel och svarar 401 i stället för att generera. Se
  // derivedApiKey() i runtimeLayout.ts.
  //
  // Det som FAKTISKT händer vid en krock står i portListening(), och det är
  // uppmätt: den andra llama-servern binder utan att klaga men får aldrig en
  // anslutning. Hanteringen sitter i start().
  return port === 11434 || port === 11435 ? 11436 : port;
}

function idleUnloadMs(): number {
  const configured = cfg().get<number>("instruct.idleUnloadMs");
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_IDLE_UNLOAD_MS;
  }
  // 0 = aldrig ladda ur. Den som har minne över ska få hålla modellen varm.
  return configured <= 0 ? 0 : Math.max(30_000, configured);
}

class InstructModelServer {
  private proc: cp.ChildProcess | undefined;
  private endpoint: InstructEndpoint | undefined;
  private starting: Promise<InstructEndpoint | undefined> | undefined;
  /** Sätts bara av fel som INTE går över av sig själv (saknad runtime, avstängd). */
  private failed = false;
  /**
   * Porten någon annan höll, när DET var orsaken. Skiljer "modellen saknas" från
   * "porten är upptagen" -- två helt olika saker för användaren att göra något åt.
   */
  private portConflict: number | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  /** Anrop som pågår just nu. Idle-timern får aldrig riva under ett svar. */
  private inFlight = 0;
  private readonly log: vscode.LogOutputChannel;

  constructor(private readonly onStateChange: () => void) {
    this.log = vscode.window.createOutputChannel("Freya (instruct model)", {
      log: true,
    });
  }

  dispose(): void {
    this.stop();
    this.log.dispose();
  }

  /** Stänger av barnprocessen. Inga zombies kvar som håller filer låsta. */
  stop(): void {
    this.clearIdleTimer();
    const proc = this.proc;
    this.proc = undefined;
    this.endpoint = undefined;
    if (!proc || proc.exitCode !== null) {
      return;
    }
    try {
      if (process.platform === "win32" && proc.pid) {
        // SIGTERM är inte tillförlitligt mot en fristående .exe på Windows;
        // taskkill /T tar även eventuella barn.
        cp.spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        proc.kill("SIGTERM");
      }
    } catch (err) {
      this.log.warn(`could not stop llama-server: ${String(err)}`);
    }
  }

  get current(): InstructEndpoint | undefined {
    return this.endpoint;
  }

  get isUnavailable(): boolean {
    return this.failed;
  }

  get conflictingPort(): number | undefined {
    return this.portConflict;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Startar om nedräkningen mot idle-unload. Anropas efter varje avslutat
   * anrop, inte före: en 40-sekunders generering ska inte äta av tystnaden.
   */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    const ms = idleUnloadMs();
    if (ms === 0 || !this.endpoint) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.inFlight > 0) {
        // Ett anrop hann komma in. Vänta ut det i stället för att riva under
        // fötterna på det -- timern armas om när det är klart.
        this.armIdleTimer();
        return;
      }
      this.log.info(`idle for ${ms} ms -- unloading the instruct model`);
      this.stop();
      this.onStateChange();
    }, ms);
    // Håll inte extension host vid liv bara för den här timern.
    this.idleTimer.unref?.();
  }

  /**
   * Markerar att ett anrop börjat/slutat. Utan den här bokföringen kan
   * idle-timern riva processen mitt i en generering, och användaren ser ett
   * avbrutet svar utan förklaring.
   */
  beginCall(): void {
    this.inFlight++;
    this.clearIdleTimer();
  }

  endCall(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0) {
      this.armIdleTimer();
    }
  }

  /**
   * Släpper den CACHADE endpointen utan att röra processen.
   *
   * ─────────────────────────────────────────────────────────────────────
   * VARFÖR DEN BEHÖVS -- ett race mellan två fönster, inte en teori.
   *
   * probeReady()-grenen i start() gör att ett andra fönster ÅTERANVÄNDER en
   * llama-server som redan kör i stället för att ladda 2 GB en gång till.
   * Fönster B får då en endpoint till en process det inte äger: this.proc är
   * undefined hos B, så B får inget "exit"-event när processen dör.
   *
   *
   * Fönster A äger processen och river den vid idle-unload. Efter det har B
   * kvar en cachad endpoint som pekar på ingenting, och ensure() returnerar
   * den rakt av (`if (this.endpoint) return this.endpoint`) utan att proba om.
   * Varje instruct-anrop i B ger ECONNREFUSED tills B:s EGEN idle-timer råkar
   * lösa ut -- eller för alltid, om användaren satt idleUnloadMs till 0.
   *
   * Fixen är att anroparen släpper cachen när kontakten faktiskt uteblev och
   * frågar en gång till. Nästa ensure() probar om: kör någon annan servern
   * adopteras den, annars startas en ny.
   *
   * Processen rörs INTE här. Äger vi den är den vår att stoppa via stop(); äger
   * vi den inte finns det inget att stoppa. Det ägda fallet läker redan av sig
   * självt -- "exit"-handlern nollar både proc och endpoint.
   * ─────────────────────────────────────────────────────────────────────
   */
  invalidateEndpoint(): void {
    this.endpoint = undefined;
    this.clearIdleTimer();
  }

  /** Startar vid behov. Samtidiga anrop delar samma start. */
  async ensure(): Promise<InstructEndpoint | undefined> {
    if (this.endpoint) return this.endpoint;
    if (this.failed) return undefined;
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => {
      this.starting = undefined;
      this.onStateChange();
    });
    return this.starting;
  }

  /**
   * Kort nådatid för att servern på porten ska visa sig vara VÅR.
   *
   * ─────────────────────────────────────────────────────────────────────
   * VARFÖR BARA NÅGRA SEKUNDER, och inte hela HEALTH_TIMEOUT_MS.
   *
   * Den uppenbara farhågan är att ett annat fönster just startat servern och
   * fortfarande läser in modellen -- då vore det fel att ge upp direkt. Men
   * den fasen finns inte i den llama-server vi buntar. Ur dess egen logg:
   *
   *   srv  load_model: loading model '...granite-3b...gguf'
   *   srv  llama_server: model loaded
   *   srv  llama_server: listening on http://127.0.0.1:18437
   *
   * Den BINDER PORTEN FÖRST EFTER att modellen är inläst. Lyssnar någon på
   * porten är den alltså redan färdigladdad, och svarar den då 401 på vår
   * nyckel är det någon annans server som aldrig kommer att bli vår.
   *
   * Nådatiden står kvar ändå, kort, som billig försäkring: skulle en framtida
   * llama.cpp börja binda tidigare blir det här en fördröjning på några
   * sekunder i stället för ett felaktigt "porten är upptagen".
   * ─────────────────────────────────────────────────────────────────────
   */
  private async waitForForeignServer(
    baseUrl: string,
    apiKey: string
  ): Promise<boolean> {
    const deadline = Date.now() + FOREIGN_SERVER_GRACE_MS;
    for (;;) {
      if (await probeReady(baseUrl, apiKey)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async start(): Promise<InstructEndpoint | undefined> {
    if (cfg().get<boolean>("instruct.enabled") === false) {
      this.log.info("instruct model disabled via freya.instruct.enabled");
      this.failed = true;
      return undefined;
    }

    const runtime = findRuntime(cfg().get<string>("instruct.runtimePath"), MODEL_SUBDIR);
    if (!runtime) {
      // Helt normalt i ett dev-träd: resources/freya-runtime är gitignore:ad.
      // Till skillnad från FIM-lanen finns INGEN Ollama-reserv här -- hela
      // poängen med lanen är att den kör lokalt utan installation.
      this.log.info(
        "no embedded instruct runtime found (resources/freya-runtime/model-instruct)"
      );
      this.failed = true;
      return undefined;
    }

    const port = instructPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const apiKey = derivedApiKey(runtime.model);
    const modelName = path.basename(runtime.model);

    // Redan igång? Ett andra fönster ska INTE ladda 2 GB en gång till.
    if (await probeReady(baseUrl, apiKey)) {
      this.log.info(`reusing the llama-server already running on ${baseUrl}`);
      this.endpoint = { baseUrl, apiKey, modelName };
      this.armIdleTimer();
      return this.endpoint;
    }

    // NÅGON ANNAN sitter på porten. Att spawna då är meningslöst: på Windows
    // binder llama-server utan att klaga men får aldrig en anslutning -- den
    // första socketen behåller porten (uppmätt, se portListening()). Vi hade
    // alltså läst in 2 GB i en process som inte kan svara.
    //
    // KVARSTÅENDE, KÄNT OCH BEGRÄNSAT: kontrollen hjälper inte under de ~4
    // sekunder ett annat fönsters server LÄSER IN modellen, för då lyssnar
    // ingen än. Två fönster som utlöser en instruct-funktion inom samma
    // sekund laddar alltså båda 2 GB, och den som förlorar kapplöpningen får
    // en process som aldrig tar emot något. Det rättar sig självt: båda
    // adopterar vinnarens server (nyckeln är härledd och alltså densamma),
    // och förloraren rivs vid idle-unload eller när fönstret stängs. Ett
    // låsfil-protokoll för att stänga ett fyra sekunders fönster är mer
    // maskineri än problemet är värt.
    //
    // Men det kan också vara ETT ANNAT FÖNSTER vars server fortfarande läser in
    // modellen; då ska vi vänta ut den och adoptera, inte vägra. Så: probea
    // vidare utan att spawna, och skilj på fallen först när tiden är ute.
    if (await portListening(port)) {
      this.log.info(
        `port ${port} is already in use -- waiting to see if it becomes ours`
      );
      const shared = await this.waitForForeignServer(baseUrl, apiKey);
      if (shared) {
        this.log.info(`adopted the llama-server on ${baseUrl}`);
        this.endpoint = { baseUrl, apiKey, modelName };
        this.armIdleTimer();
        return this.endpoint;
      }
      this.log.error(
        `port ${port} is held by another process that is not Freya's instruct ` +
          `server. Set freya.instruct.port to a free port.`
      );
      this.portConflict = port;
      this.failed = true;
      return undefined;
    }

    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-m",
      runtime.model,
      "--ctx-size",
      String(cfg().get<number>("instruct.contextSize") ?? 8192),
      "--api-key",
      apiKey,
      // Samma resonemang som i FIM-lanen: inget web-UI, men loggning kvar.
      "--no-webui",
    ];

    this.log.info(`starting ${runtime.exe} on ${baseUrl} with ${modelName}`);
    const proc = cp.spawn(runtime.exe, args, {
      cwd: path.dirname(runtime.exe),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stderr?.on("data", (b) => this.log.trace(String(b).trimEnd()));
    proc.stdout?.on("data", (b) => this.log.trace(String(b).trimEnd()));
    proc.on("error", (err) => {
      this.log.error(`llama-server could not be started: ${err.message}`);
      this.failed = true;
      this.proc = undefined;
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) {
        this.log.warn(`llama-server exited (code=${code} signal=${signal})`);
        this.proc = undefined;
        this.endpoint = undefined;
        this.onStateChange();
      }
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) {
        this.failed = true;
        return undefined; // processen dog under uppstart
      }
      if (await probeReady(baseUrl, apiKey)) {
        this.log.info(`ready after ${HEALTH_TIMEOUT_MS - (deadline - Date.now())} ms`);
        this.endpoint = { baseUrl, apiKey, modelName };
        this.armIdleTimer();
        return this.endpoint;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    this.log.error(`no successful health check within ${HEALTH_TIMEOUT_MS} ms -- giving up`);
    this.stop();
    this.failed = true;
    return undefined;
  }
}

let server: InstructModelServer | undefined;

export function initInstructServer(
  ctx: vscode.ExtensionContext,
  onStateChange: () => void = () => {}
): void {
  server = new InstructModelServer(onStateChange);
  ctx.subscriptions.push({ dispose: () => server?.dispose() });

  // Sista utposten mot zombies: om extension host rivs utan att dispose körs.
  const killOnExit = () => server?.stop();
  process.once("exit", killOnExit);
  ctx.subscriptions.push({
    dispose: () => process.removeListener("exit", killOnExit),
  });

  // INGEN ensure() här -- till skillnad från localServer.initLocalServer().
  // Lanen är on-demand; att starta 2 GB vid uppstart hade tagit tillbaka
  // precis det minne konstruktionen finns för att spara.
}

/**
 * Endpointen till instruct-modellen. STARTAR den om den inte kör.
 * undefined = ingen 3B installerad (dev-träd, eller avstängd).
 */
export async function instructEndpoint(): Promise<InstructEndpoint | undefined> {
  return server ? server.ensure() : undefined;
}

/** Ramar in ett anrop så att idle-timern inte river mitt i det. */
export function beginInstructCall(): void {
  server?.beginCall();
}

export function endInstructCall(): void {
  server?.endCall();
}

/**
 * Släpper den cachade endpointen. Anropas av instructModel.ts när ett anrop
 * inte fick KONTAKT (till skillnad från ett HTTP-fel, som betyder att servern
 * lever och svarade). Se invalidateEndpoint() ovan för racet den löser.
 */
export function invalidateInstructEndpoint(): void {
  server?.invalidateEndpoint();
}

/**
 * Porten som var upptagen, om DET var varför lanen inte gick att starta.
 * undefined = något annat (eller inget) var fel.
 */
export function instructConflictingPort(): number | undefined {
  return server?.conflictingPort;
}

/** Nuvarande läge UTAN att starta något. För statusraden och hälsokollen. */
export function instructState(): {
  endpoint?: InstructEndpoint;
  unavailable: boolean;
} {
  return {
    endpoint: server?.current,
    unavailable: server?.isUnavailable ?? true,
  };
}

/**
 * Finns 3B:n på disk? Svarar UTAN att starta processen, så knappar och
 * CodeLenses kan gömma sig i ett dev-träd utan att kosta 4 sekunders uppstart.
 */
export function instructInstalled(): boolean {
  if (cfg().get<boolean>("instruct.enabled") === false) {
    return false;
  }
  return !!findRuntime(cfg().get<string>("instruct.runtimePath"), MODEL_SUBDIR);
}
