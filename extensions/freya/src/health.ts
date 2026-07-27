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
      "Prefer the cloud? Set `freya.chat.backend` to `workersai` and run **Freya: Set Cloudflare keys**.",
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

/** Vad statusraden ska berätta om de två lanerna. */
export interface LaneStatus {
  /** Namnet på den lätta lanens modell, eller undefined om den inte är uppe. */
  lightModel?: string;
  /** true när den lätta lanen är den inbäddade modellen. */
  lightIsEmbedded: boolean;
  /** Tunga lanens backend efter routning. */
  heavy: "workersai" | "ollama";
  /** true när molnnycklar finns. */
  cloudKeys: boolean;
}

/**
 * Statusraden visar ARBETSFÖRDELNINGEN, inte bara fel: vilken lätt modell som
 * svarar och vart det tunga går. Poängen är att en användare ska kunna se att
 * appen fungerar utan Ollama och utan molnnycklar — inte gissa.
 */
export function renderHealthStatus(
  item: vscode.StatusBarItem,
  health: OllamaHealth,
  needed: string[],
  url: string,
  lanes?: LaneStatus
): void {
  const heavyText = (l: LaneStatus) =>
    l.heavy === "workersai"
      ? l.cloudKeys
        ? "Workers AI"
        : "Workers AI (keys missing)"
      : "Ollama";

  // Lätta lanen kör på den inbäddade modellen: då FUNGERAR appen, oavsett vad
  // Ollama gör. Ett Ollama-fel får inte se ut som att allt är trasigt.
  if (lanes?.lightIsEmbedded && lanes.lightModel) {
    item.text = "$(chip) Freya: 1.5B local";
    item.tooltip =
      `Light (autocomplete, commit, explain): embedded ${lanes.lightModel}\n` +
      `Heavy (agent/chat): ${heavyText(lanes)}\n\n` +
      (health.reachable
        ? `Ollama is responding on ${url}.`
        : `Ollama is not responding on ${url} -- not needed for the light lane.`) +
      `\n\nClick to check Ollama and the models.`;
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

  // Allt via Ollama och inget saknas: visa vart lanerna pekar, utan varning.
  if (lanes) {
    item.text = "$(server) Freya: Ollama";
    item.tooltip =
      `Light: Ollama (no embedded model found)\n` +
      `Heavy: ${heavyText(lanes)}`;
    item.backgroundColor = undefined;
    item.show();
    return;
  }

  item.hide();
}
