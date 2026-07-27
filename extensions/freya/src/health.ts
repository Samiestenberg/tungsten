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
        error: `HTTP ${res.status} från ${url}/api/tags`,
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
      error: err?.name === "AbortError" ? `Ingen svarstid inom ${timeoutMs} ms` : String(err?.message ?? err),
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
      `**Ollama svarar inte på ${url}.**`,
      "",
      `Freyas chatt och autocomplete kör lokalt via Ollama. Starta den, eller installera från https://ollama.com/download.`,
      "",
      "```",
      "ollama serve",
      ...needed.map((m) => `ollama pull ${m}`),
      "```",
      "",
      health.error ? `_Detaljer: ${health.error}_` : "",
      "",
      "Har du hellre moln? Sätt `freya.chat.backend` till `workersai` och kör **Freya: Ange Cloudflare-nycklar**.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  const missing = needed.filter((m) => !hasModel(health, m));
  if (missing.length === 0) {
    return undefined;
  }

  return [
    `**Ollama kör, men ${missing.length === 1 ? "modellen saknas" : "modellerna saknas"}.**`,
    "",
    "Hämta med:",
    "",
    "```",
    ...missing.map((m) => `ollama pull ${m}`),
    "```",
    "",
    `_Hittade i Ollama: ${health.models.length ? health.models.join(", ") : "inga modeller"}_`,
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

export function renderHealthStatus(
  item: vscode.StatusBarItem,
  health: OllamaHealth,
  needed: string[],
  url: string
): void {
  if (!health.reachable) {
    item.text = "$(warning) Freya: Ollama nere";
    item.tooltip = `Ollama svarar inte på ${url}. Klicka för att kolla igen.`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    item.show();
    return;
  }

  const missing = needed.filter((m) => !hasModel(health, m));
  if (missing.length > 0) {
    item.text = `$(cloud-download) Freya: ${missing.length} modell${missing.length === 1 ? "" : "er"} saknas`;
    item.tooltip = `Kör: ${missing.map((m) => `ollama pull ${m}`).join(" && ")}`;
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    item.show();
    return;
  }

  item.hide();
}
