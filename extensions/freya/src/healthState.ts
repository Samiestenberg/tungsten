// Delat hälsotillstånd för statusraden.
//
// Egen modul för att autocomplete.ts ska kunna rapportera "modellen svarade
// inte" utan att importera extension.ts (det hade blivit en cirkel).
// Modulnivå-state är rimligt här: statusraden är en enda per fönster.
import * as vscode from "vscode";
import { autocompleteModel, lightBackend, ollamaUrl } from "./config.js";
import { localState } from "./localServer.js";
import { instructInstalled, instructState } from "./instructServer.js";
import {
  createHealthStatusItem,
  probeOllama,
  renderHealthStatus,
} from "./health.js";

let statusItem: vscode.StatusBarItem | undefined;
let refreshing = false;
let lastRefresh = 0;

/**
 * Modellerna som måste finnas i OLLAMA för att det vi använder ska fungera.
 *
 * Efter FAS R är listan tom i default-bygget: instruct-lanen är inbäddad och
 * FIM-lanen likaså. Ollama behövs bara för den som själv satt
 * freya.light.backend till "ollama".
 */
function neededModels(): string[] {
  if (lightBackend() === "embedded" && localState().endpoint) {
    return [];
  }
  return [autocompleteModel()];
}

export async function refreshHealth(): Promise<void> {
  if (!statusItem || refreshing) {
    return;
  }
  refreshing = true;
  lastRefresh = Date.now();
  try {
    const url = ollamaUrl();
    const health = await probeOllama(url);
    const local = localState();
    const instruct = instructState();
    renderHealthStatus(statusItem, health, neededModels(), url, {
      lightModel: local.endpoint?.modelName,
      lightIsEmbedded: lightBackend() === "embedded" && !!local.endpoint,
      // installed != loaded. 3B laddas ur efter ~5 minuters tystnad, och
      // statusraden ska visa "finns, laddas vid behov" och inte "saknas".
      instructInstalled: instructInstalled(),
      instructModel: instruct.endpoint?.modelName,
    });
  } finally {
    refreshing = false;
  }
}

/**
 * Anropas när en FIM-request misslyckades. Kastar INTE igång en probe per
 * tangenttryck: en misslyckad komplettering räcker som signal, sen får det
 * gå 30 sekunder innan vi frågar igen.
 */
export function reportAutocompleteOutage(): void {
  if (Date.now() - lastRefresh < 30_000) {
    return;
  }
  void refreshHealth();
}

export function initHealthState(ctx: vscode.ExtensionContext): void {
  statusItem = createHealthStatusItem(ctx);

  // Ingen await: uppstarten ska inte vänta på en probe.
  void refreshHealth();

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("freya.ollama.url") ||
        e.affectsConfiguration("freya.light.backend") ||
        e.affectsConfiguration("freya.instruct.enabled") ||
        e.affectsConfiguration("freya.autocomplete.model")
      ) {
        void refreshHealth();
      }
    })
  );
}
