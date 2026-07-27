import * as vscode from "vscode";
import { registerParticipant } from "./participant.js";
import { registerLanguageModel } from "./languageModel.js";
import { registerAutocomplete } from "./autocomplete.js";
import {
  clearKeys,
  promptAndStoreKeys,
  chatBackend,
  ollamaUrl,
  chatModel,
  autocompleteModel,
} from "./config.js";
import { initHealthState, refreshHealth } from "./healthState.js";
import { ollamaGuidance, probeOllama } from "./health.js";
import { registerCommitMessage } from "./commitMessage.js";
import { registerSecretsGuard } from "./secretsGuard.js";
import { registerStagedSecretScan } from "./secretsStaged.js";
import { initLocalServer } from "./localServer.js";
import { registerExplain } from "./explain.js";

export function activate(ctx: vscode.ExtensionContext): void {
  // Den inbäddade 1.5B-servern startas FÖRST men utan await: allt lätt
  // (autocomplete, commit-meddelanden, förklaringar) ska gå mot den, och den
  // ska vara på väg upp medan resten registreras. Saknas runtime:n faller
  // anroparna tillbaka på Ollama av sig själva.
  initLocalServer(ctx, () => void refreshHealth());

  // Ordning spelar roll: utan en registrerad vscode.lm-modell avvisas varje
  // chat-request med "Language model unavailable" innan Freyas handler nås.
  registerLanguageModel(ctx);
  registerParticipant(ctx);
  registerAutocomplete(ctx);
  registerCommitMessage(ctx);
  registerSecretsGuard(ctx);
  registerStagedSecretScan(ctx);
  registerExplain(ctx);

  // Hälsokoll vid uppstart. Icke-blockerande: Freya aktiveras även om Ollama
  // är nere, och läget syns som en statusrad bara när något saknas.
  initHealthState(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.setKeys", async () => {
      await clearKeys(ctx);
      const ok = await promptAndStoreKeys(ctx);
      if (ok) {
        vscode.window.showInformationMessage(
          "Freya: Cloudflare-nycklar sparade i OS-nyckelringen."
        );
      }
    }),
    vscode.commands.registerCommand("freya.clearKeys", async () => {
      await clearKeys(ctx);
      vscode.window.showInformationMessage("Freya: nycklar raderade.");
    }),
    vscode.commands.registerCommand("freya.checkOllama", async () => {
      const url = ollamaUrl();
      const needed =
        chatBackend() === "ollama"
          ? [chatModel(), autocompleteModel()]
          : [autocompleteModel()];
      const health = await probeOllama(url);
      await refreshHealth();
      const guidance = ollamaGuidance(health, [...new Set(needed)], url);
      if (!guidance) {
        vscode.window.showInformationMessage(
          `Freya: Ollama svarar på ${url} och alla modeller finns.`
        );
        return;
      }
      // Panelen är rätt yta för instruktioner (markdown, kopierbar kodrad).
      // Notifieringen är bara vägvisaren dit.
      const open = await vscode.window.showWarningMessage(
        health.reachable
          ? "Freya: en Ollama-modell saknas."
          : `Freya: Ollama svarar inte på ${url}.`,
        "Visa i chatten"
      );
      if (open === "Visa i chatten") {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: "@freya hej",
        });
      }
    }),
    vscode.commands.registerCommand("freya.showBackend", () => {
      const backend = chatBackend();
      const model =
        backend === "ollama"
          ? vscode.workspace
              .getConfiguration("freya")
              .get<string>("chat.ollamaModel")
          : vscode.workspace
              .getConfiguration("freya")
              .get<string>("chat.workersAiModel");
      vscode.window.showInformationMessage(
        `Freya chattar via ${backend} (${model}). Autocomplete kör alltid lokalt.`
      );
    })
  );
}

export function deactivate(): void {
  // Allt ligger i ctx.subscriptions.
}
