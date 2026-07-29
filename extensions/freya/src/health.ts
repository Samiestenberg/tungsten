// Hälsokoll mot Ollama.
//
// VARFÖR: Freya förutsatte tyst att Ollama körde och att rätt modeller var
// hämtade. Saknades något dog chatten och autocomplete utan ett ord -- inga
// förslag, inget svar, ingen förklaring. Den här filen gör felet läsbart och
// säger exakt vilket kommando som fixar det. Den installerar aldrig något.
import * as vscode from "vscode";

export interface OllamaHealth {
  /** Svarade Ollama på /api/tags? */
  reachable: boolean;
  /** Modellnamn som Ollama rapporterar, t.ex. "qwen2.5-coder:14b". */
  models: string[];
  /** Felmeddelandet från fetch när reachable är false. */
  error?: string;
}

/** Ollama defaultar taggen till :latest, så "qwen3" och "qwen3:latest" är samma modell. */
function normalize(model: string): string {
  const trimmed = model.trim();
  return trimmed.includes(":") ? trimmed : `${trimmed}:latest`;
}

export function hasModel(health: OllamaHealth, model: string): boolean {
  const want = normalize(model);
  return health.models.some((m) => normalize(m) === want);
}

/**
 * Frågar Ollama vilka modeller som finns. Kastar aldrig: ett nere-läge är ett
 * svar, inte ett undantag. Timeouten hindrar att en hängande Ollama låser
 * uppstarten eller ett chat-svar.
 */
export async function probeOllama(
  url: string,
  timeoutMs = 2000
): Promise<OllamaHealth> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: ac.signal });
    if (!res.ok) {
      return {
        reachable: false,
        models: [],
        error: `HTTP ${res.status} from ${url}/api/tags`,
      };
    }
    const data: any = await res.json();
    const models = Array.isArray(data?.models)
      ? data.models
          .map((m: any) => String(m?.name ?? m?.model ?? ""))
          .filter(Boolean)
      : [];
    return { reachable: true, models };
  } catch (err: any) {
    return {
      reachable: false,
      models: [],
      error: err?.name === "AbortError" ? `No response within ${timeoutMs} ms` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Markdown att visa i chattpanelen när något saknas, annars undefined.
 * `needed` är modellerna som just den här ytan behöver.
 */
export function ollamaGuidance(
  health: OllamaHealth,
  needed: string[],
  url: string
): string | undefined {
  if (!health.reachable) {
    return [
      `**Ollama is not responding on ${url}.**`,
      "",
      `Freya can use Ollama for chat and autocomplete. Start it, or install it from https://ollama.com/download.`,
      "",
      "```",
      "ollama serve",
      ...needed.map((m) => `ollama pull ${m}`),
      "```",
      "",
      health.error ? `_Details: ${health.error}_` : "",
      "",
      "You only need Ollama if you set `freya.light.backend` to `ollama`. " +
        "The default build has both models embedded and needs nothing installed.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  const missing = needed.filter((m) => !hasModel(health, m));
  if (missing.length === 0) {
    return undefined;
  }

  return [
    `**Ollama is running, but ${missing.length === 1 ? "the model is missing" : "the models are missing"}.**`,
    "",
    "Pull it with:",
    "",
    "```",
    ...missing.map((m) => `ollama pull ${m}`),
    "```",
    "",
    `_Found in Ollama: ${health.models.length ? health.models.join(", ") : "no models"}_`,
  ].join("\n");
}

/**
 * Statusrad som gör läget synligt utan att blockera. Visas bara när något är
 * fel -- en grön ikon för "allt funkar" är bara brus.
 */
export function createHealthStatusItem(
  ctx: vscode.ExtensionContext
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    "freya.health",
    vscode.StatusBarAlignment.Right,
    100
  );
  item.name = "Freya";
  item.command = "freya.checkOllama";
  ctx.subscriptions.push(item);
  return item;
}

/** Vad statusraden ska berätta om de två LOKALA lanerna. */
export interface LaneStatus {
  /** Namnet på FIM-lanens modell, eller undefined om den inte är uppe. */
  lightModel?: string;
  /** true när FIM-lanen är den inbäddade modellen (inte Ollama-reserven). */
  lightIsEmbedded: boolean;
  /** true när 3B-instruct finns installerad i det här bygget. */
  instructInstalled: boolean;
  /** Namnet på instruct-modellen NÄR den är laddad. Undefined = urladdad. */
  instructModel?: string;
}

/**
 * Statusraden visar ARBETSFÖRDELNINGEN, inte bara fel: vilka modeller som
 * svarar. Poängen är att en användare ska kunna SE att appen fungerar utan
 * Ollama, utan konto och utan nätverk -- inte gissa.
 *
 * FAS R tog bort molnet och den tunga Ollama-lanen härifrån. Det som stod
 * "Heavy: Workers AI (keys missing)" var i praktiken en uppmaning att skaffa
 * ett konto för att appen skulle kännas hel, och den uppmaningen stämmer inte
 * längre: allt som behövs följer med i installern.
 */
export function renderHealthStatus(
  item: vscode.StatusBarItem,
  health: OllamaHealth,
  needed: string[],
  url: string,
  lanes?: LaneStatus
): void {
  const instructText = (l: LaneStatus) =>
    !l.instructInstalled
      ? "not installed in this build"
      : l.instructModel
        ? `${l.instructModel} (loaded)`
        : "3B instruct (loads on first use)";

  item.command = "freya.checkOllama";

  // FIM-lanen kör på den inbäddade modellen: då FUNGERAR appen, oavsett vad
  // Ollama gör. Ett Ollama-fel får inte se ut som att allt är trasigt.
  if (lanes?.lightIsEmbedded && lanes.lightModel) {
    item.text = "$(chip) Freya: local";
    item.tooltip =
      `Completion, next edit, syntax fix, commit messages: ${lanes.lightModel}\n` +
      `Explain, rewrite, fix, tests, chat: ${instructText(lanes)}\n\n` +
      "Both run on this machine. No account, no network." +
      (health.reachable
        ? `\n\nOllama is also responding on ${url}, but nothing needs it.`
        : "");
    item.backgroundColor = undefined;
    item.show();
    return;
  }

  if (!health.reachable) {
    item.text = "$(warning) Freya: Ollama down";
    item.tooltip =
      `Ollama is not responding on ${url}. Click to check again.` +
      (lanes ? `\n\nNo embedded model found, so the light lane is down too.` : "");
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    item.show();
    return;
  }

  const missing = needed.filter((m) => !hasModel(health, m));
  if (missing.length > 0) {
    item.text = `$(cloud-download) Freya: ${missing.length} model${missing.length === 1 ? "" : "s"} missing`;
    item.tooltip = `Run: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    item.show();
    return;
  }

  // FIM-reserven kör via Ollama och inget saknas.
  if (lanes) {
    item.text = "$(server) Freya: Ollama";
    item.tooltip =
      "Completion: your own Ollama (no embedded model found)\n" +
      `Explain, rewrite, fix, tests, chat: ${instructText(lanes)}`;
    item.backgroundColor = undefined;
    item.show();
    return;
  }

  item.hide();
}
