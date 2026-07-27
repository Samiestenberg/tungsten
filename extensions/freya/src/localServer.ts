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
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface LocalEndpoint {
  /** t.ex. http://127.0.0.1:11435 */
  readonly baseUrl: string;
  /** Skickas som Authorization: Bearer. Se nyckelresonemanget nedan. */
  readonly apiKey: string;
  /** Filnamnet på GGUF:en, för loggar och statusrad. */
  readonly modelName: string;
}

const SERVER_EXE = "llama-server.exe";
const MODEL_GLOB_SUFFIX = ".gguf";
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

/**
 * Var runtime:n ligger. `vscode.env.appRoot` är resources/app i ett packat
 * bygge och repo-roten i dev, så båda fallen täcks av de två kandidaterna.
 */
function runtimeRoots(): string[] {
  const configured = cfg().get<string>("local.runtimePath");
  const roots = configured ? [configured] : [];
  const appRoot = vscode.env.appRoot;
  roots.push(
    path.join(appRoot, "freya-runtime"), // packat bygge
    path.join(appRoot, "resources", "freya-runtime") // dev-träd
  );
  return roots;
}

interface RuntimePaths {
  exe: string;
  model: string;
}

/** Hittar binär + modell, eller undefined om något saknas. */
export function findRuntime(): RuntimePaths | undefined {
  for (const root of runtimeRoots()) {
    const exe = path.join(root, process.platform === "win32" ? "win32-x64" : "", SERVER_EXE);
    const modelDir = path.join(root, "model");
    if (!fs.existsSync(exe) || !fs.existsSync(modelDir)) {
      continue;
    }
    const model = fs
      .readdirSync(modelDir)
      .filter((f) => f.toLowerCase().endsWith(MODEL_GLOB_SUFFIX))
      .sort()[0];
    if (model) {
      return { exe, model: path.join(modelDir, model) };
    }
  }
  return undefined;
}

/**
 * Nyckeln är HÄRLEDD, inte slumpad: varje fönster räknar fram samma nyckel, så
 * ett andra fönster kan återanvända en server som redan kör i stället för att
 * ladda modellen en gång till. Poängen med nyckeln är att llama-server sätter
 * CORS till '*' -- utan den kan en godtycklig webbsida du besöker POSTa till
 * 127.0.0.1 och använda din CPU. En webbsida kan inte räkna fram den här.
 */
function derivedApiKey(modelPath: string): string {
  return crypto
    .createHash("sha256")
    .update(`freya-local:${modelPath}:${vscode.env.machineId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Redo OCH vår. Vi frågar /props och inte /health med flit: llama-server
 * lämnar /health öppet (verifierat: 200 utan nyckel) medan /props och /infill
 * svarar 401 utan rätt nyckel. En hälsokoll mot /health skulle alltså säga "ja"
 * även om det är någon ANNAN llama-server på porten -- och då hade varje
 * efterföljande anrop fallit på 401. /props svarar 200 bara om nyckeln stämmer,
 * vilket är exakt villkoret för att vi ska få återanvända servern.
 */
async function probeReady(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 1500
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/props`, {
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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

    const runtime = findRuntime();
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

/** Nuvarande läge utan att starta något. För statusraden. */
export function localState(): { endpoint?: LocalEndpoint; unavailable: boolean } {
  return {
    endpoint: server?.current,
    unavailable: server?.isUnavailable ?? true,
  };
}
