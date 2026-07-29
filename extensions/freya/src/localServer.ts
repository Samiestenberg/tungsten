// Den INBÄDDADE lokala modellen: llama.cpp-server som barnprocess.
//
// VARFÖR BARNPROCESS OCH INTE IN-PROCESS (node-llama-cpp): en native modul
// måste matcha VS Codes Electron/Node-ABI exakt. En fristående .exe som vi
// pratar HTTP med bryr sig inte om vilken Electron vi kör -- den överlever
// Electron-uppgraderingar och slipper hela node-gyp-klassen av problem.
//
// Servern lyssnar på 127.0.0.1 och en EGEN port (default 11435). Aldrig 11434:
// den porten äger Ollama, och användarens egen Ollama ska inte krockas med.
//
// Saknas binären eller modellen (t.ex. ett dev-träd utan resources/freya-runtime)
// returnerar localEndpoint() undefined, och anroparen faller tillbaka på Ollama.
import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { derivedApiKey, findRuntime, probeReady } from "./runtimeLayout.js";

export interface LocalEndpoint {
  /** t.ex. http://127.0.0.1:11435 */
  readonly baseUrl: string;
  /** Skickas som Authorization: Bearer. Se nyckelresonemanget nedan. */
  readonly apiKey: string;
  /** Filnamnet på GGUF:en, för loggar och statusrad. */
  readonly modelName: string;
}

/** Modellmappen som HÖR TILL den här lanen. 3B:n bor i model-instruct/. */
const MODEL_SUBDIR = "model";
const HEALTH_TIMEOUT_MS = 60_000;

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

export function localPort(): number {
  const port = cfg().get<number>("local.port") ?? 11435;
  // 11434 är Ollamas. Att spawna vår server där skulle antingen krocka med
  // användarens Ollama eller -- värre -- få oss att prata med den i tron att
  // det är vår inbäddade modell.
  return port === 11434 ? 11435 : port;
}

// Sökvägsuppslag, nyckelhärledning och /props-proben bor i runtimeLayout.ts.
// Instruct-lanen (3B, port 11436) anropar SAMMA funktioner med en annan
// modellmapp, så de två lanerna kan inte glida isär i var de letar.

class LocalModelServer {
  private proc: cp.ChildProcess | undefined;
  private endpoint: LocalEndpoint | undefined;
  private starting: Promise<LocalEndpoint | undefined> | undefined;
  private failed = false;
  private readonly log: vscode.LogOutputChannel;

  constructor(private readonly onStateChange: () => void) {
    this.log = vscode.window.createOutputChannel("Freya (local model)", {
      log: true,
    });
  }

  dispose(): void {
    this.stop();
    this.log.dispose();
  }

  /** Stänger av barnprocessen. Inga zombies kvar som håller filer låsta. */
  stop(): void {
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

  get current(): LocalEndpoint | undefined {
    return this.endpoint;
  }

  get isUnavailable(): boolean {
    return this.failed;
  }

  /**
   * Släpper den CACHADE endpointen utan att röra processen.
   *
   * ─────────────────────────────────────────────────────────────────────
   * SAMMA RACE SOM I INSTRUCT-LANEN, men med en värre svans här.
   *
   * probeReady()-grenen i start() gör att ett andra fönster återanvänder en
   * llama-server som redan kör. Fönster B får då en endpoint till en process
   * det inte äger -- this.proc är undefined hos B, så B får inget "exit"-event.
   *
   * När fönster A stängs kör dess dispose() -> stop() -> taskkill. B sitter kvar
   * med en cachad endpoint som pekar på ingenting, och ensure() returnerar den
   * rakt av utan att proba om.
   *
   * VARFÖR DET ÄR VÄRRE HÄR: instruct-lanen har en idle-timer som förr eller
   * senare nollar endpointen. FIM-lanen har ingen -- den är avsiktligt alltid
   * uppe. Utan den här ventilen är B:s autocomplete alltså trasig för RESTEN AV
   * SESSIONEN, och symptomet är bara att förslagen tystnar.
   *
   * Processen rörs inte: äger vi den är den vår att stoppa via stop(), och äger
   * vi den inte finns det inget att stoppa.
   * ─────────────────────────────────────────────────────────────────────
   */
  invalidateEndpoint(): void {
    this.endpoint = undefined;
  }

  /** Startar vid behov. Samtidiga anrop delar samma start. */
  async ensure(): Promise<LocalEndpoint | undefined> {
    if (this.endpoint) return this.endpoint;
    if (this.failed) return undefined;
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => {
      this.starting = undefined;
      this.onStateChange();
    });
    return this.starting;
  }

  private async start(): Promise<LocalEndpoint | undefined> {
    if (cfg().get<boolean>("local.enabled") === false) {
      this.log.info("embedded model disabled via freya.local.enabled");
      this.failed = true;
      return undefined;
    }

    const runtime = findRuntime(cfg().get<string>("local.runtimePath"), MODEL_SUBDIR);
    if (!runtime) {
      // Helt normalt i ett dev-träd: resources/freya-runtime är gitignore:ad.
      this.log.info(
        "no embedded runtime found (resources/freya-runtime) -- falling back to Ollama"
      );
      this.failed = true;
      return undefined;
    }

    const port = localPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const apiKey = derivedApiKey(runtime.model);
    const modelName = path.basename(runtime.model);

    // Redan igång? Ett andra fönster ska INTE ladda modellen en gång till.
    if (await probeReady(baseUrl, apiKey)) {
      this.log.info(`reusing the llama-server already running on ${baseUrl}`);
      this.endpoint = { baseUrl, apiKey, modelName };
      return this.endpoint;
    }

    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-m",
      runtime.model,
      "--ctx-size",
      String(cfg().get<number>("local.contextSize") ?? 4096),
      "--api-key",
      apiKey,
      // Ingen web-UI: servern ska svara på API-anrop, inte vara en sida någon
      // kan öppna. Loggningen är MEDVETET kvar (går till output-kanalen på
      // trace-nivå) — utan den är "modellen startade inte" omöjligt att felsöka.
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

    // Modellen tar en stund att läsa in från disk första gången.
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) {
        this.failed = true;
        return undefined; // processen dog under uppstart
      }
      if (await probeReady(baseUrl, apiKey)) {
        this.log.info(`ready after ${HEALTH_TIMEOUT_MS - (deadline - Date.now())} ms`);
        this.endpoint = { baseUrl, apiKey, modelName };
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

let server: LocalModelServer | undefined;

export function initLocalServer(
  ctx: vscode.ExtensionContext,
  onStateChange: () => void = () => {}
): void {
  server = new LocalModelServer(onStateChange);
  ctx.subscriptions.push({ dispose: () => server?.dispose() });

  // Sista utposten mot zombies: om extension host rivs utan att dispose körs.
  const killOnExit = () => server?.stop();
  process.once("exit", killOnExit);
  ctx.subscriptions.push({
    dispose: () => process.removeListener("exit", killOnExit),
  });

  // Ingen await: uppstarten ska inte vänta på att modellen läses in.
  void server.ensure();
}

/** Endpointen till den inbäddade modellen, eller undefined om den inte finns. */
export async function localEndpoint(): Promise<LocalEndpoint | undefined> {
  return server ? server.ensure() : undefined;
}

/**
 * Släpper den cachade endpointen. Anropas av localModel.ts när ett anrop inte
 * fick KONTAKT -- till skillnad från ett HTTP-fel, som betyder att servern
 * lever och svarade. Se invalidateEndpoint() ovan för racet den löser.
 */
export function invalidateLocalEndpoint(): void {
  server?.invalidateEndpoint();
}

/** Nuvarande läge utan att starta något. För statusraden. */
export function localState(): { endpoint?: LocalEndpoint; unavailable: boolean } {
  return {
    endpoint: server?.current,
    unavailable: server?.isUnavailable ?? true,
  };
}
