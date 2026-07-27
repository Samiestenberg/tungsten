// Delat hälsotillstånd för statusraden.
//
// Egen modul för att autocomplete.ts ska kunna rapportera "Ollama svarade
// inte" utan att importera extension.ts (det hade blivit en cirkel).
// Modulnivå-state är rimligt här: statusraden är en enda per fönster.
import * as vscode from "vscode";
import {
  autocompleteModel,
  chatBackend,
  chatModel,
  hasCloudKeys,
  lightBackend,
  ollamaUrl,
} from "./config.js";
import { localState } from "./localServer.js";
import {
  createHealthStatusItem,
  probeOllama,
  renderHealthStatus,
} from "./health.js";

let statusItem: vscode.StatusBarItem | undefined;
let refreshing = false;
let lastRefresh = 0;

/** Modellerna som måste finnas för att det vi faktiskt använder ska fungera. */
function neededModels(): string[] {
  // Autocomplete-modellen behovs bara i Ollama nar den LATTA lanen gar dit.
  // Med den inbaddade modellen uppe ar det inget som saknas.
  const needed =
    lightBackend() === "embedded" && localState().endpoint ? [] : [autocompleteModel()];
  if (chatBackend() === "ollama") {
    needed.unshift(chatModel());
  }
  return [...new Set(needed)];
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
    renderHealthStatus(statusItem, health, neededModels(), url, {
      lightModel: local.endpoint?.modelName,
      lightIsEmbedded: lightBackend() === "embedded" && !!local.endpoint,
      heavy: chatBackend(),
      cloudKeys: hasCloudKeys(),
    });
  } finally {
    refreshing = false;
  }
}

/**
 * Anropas när en FIM-request misslyckades. Kastar INTE igång en probe per
 * tangenttryck: en misslyckad komplettering räcker som signal, sen får det
 * gå 30 sekunder innan vi frågar Ollama igen.
 */
export function reportAutocompleteOutage(): void {
  if (Date.now() - lastRefresh < 30_000) {
    return;
  }
  void refreshHealth();
}

export function initHealthState(ctx: vscode.ExtensionContext): void {
  statusItem = createHealthStatusItem(ctx);

  // Ingen await: uppstarten ska inte vänta på Ollama.
  void refreshHealth();

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("freya.ollama.url") ||
        e.affectsConfiguration("freya.chat.backend") ||
        e.affectsConfiguration("freya.chat.ollamaModel") ||
        e.affectsConfiguration("freya.autocomplete.model")
      ) {
        void refreshHealth();
      }
    })
  );
}
