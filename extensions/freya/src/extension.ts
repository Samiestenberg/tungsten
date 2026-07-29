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
  refreshCloudKeyState,
} from "./config.js";
import { initHealthState, refreshHealth } from "./healthState.js";
import { ollamaGuidance, probeOllama } from "./health.js";
import { registerCommitMessage } from "./commitMessage.js";
import { registerSecretsGuard } from "./secretsGuard.js";
import { registerStagedSecretScan } from "./secretsStaged.js";
import { initLocalServer } from "./localServer.js";
import { initInstructServer } from "./instructServer.js";
import { registerExplain } from "./explain.js";
import { registerNextEdit } from "./fim/nextEdit.js";
import { registerSyntaxFix } from "./fim/syntaxFix.js";
import { registerInlineEdit } from "./inlineEdit.js";

export function activate(ctx: vscode.ExtensionContext): void {
  // ALLT NEDAN REGISTRERAS ÄVEN I EN OBETRODD MAPP. Tillägget deklarerar
  // untrustedWorkspaces.supported: "limited", så activate() körs direkt när
  // fönstret öppnas -- tidigare kördes den inte alls, och då startade varken
  // den inbäddade modellen eller något som kunde förklara varför.
  //
  // Grinden sitter i stället per yta: agenten (participant.ts) och
  // vscode.lm-svaren (languageModel.ts) vägrar tills mappen litas på och SÄGER
  // det. Den lätta lanen läser bara och kör på.

  // Den inbäddade 1.5B-servern startas FÖRST men utan await: allt lätt
  // (autocomplete, commit-meddelanden, förklaringar) ska gå mot den, och den
  // ska vara på väg upp medan resten registreras. Saknas runtime:n faller
  // anroparna tillbaka på Ollama av sig själva.
  initLocalServer(ctx, () => void refreshHealth());

  // 3B-instruct-lanen får sin livscykel registrerad här men startas INTE nu.
  // Den spawnas vid första instruct-anropet och laddas ur efter ~5 minuters
  // tystnad. Skälet är minne: 1.5B + 3B residenta samtidigt lämnar inte plats
  // åt editorn på en 8 GB-maskin. Se instructServer.ts.
  initInstructServer(ctx, () => void refreshHealth());

  // Routningen av den TUNGA lanen (auto -> moln om nycklar finns, annars den
  // valfria Ollama-modellen) behover veta om nycklar finns. chatBackend() ar
  // synkron, sa svaret cachas har och uppdateras nar nycklarna andras.
  void refreshCloudKeyState(ctx).then(() => void refreshHealth());

  // Ordning spelar roll: utan en registrerad vscode.lm-modell avvisas varje
  // chat-request med "Language model unavailable" innan Freyas handler nås.
  registerLanguageModel(ctx);
  registerParticipant(ctx);
  registerAutocomplete(ctx);
  registerNextEdit(ctx);
  registerSyntaxFix(ctx);
  registerCommitMessage(ctx);
  registerSecretsGuard(ctx);
  registerStagedSecretScan(ctx);
  registerExplain(ctx);
  registerInlineEdit(ctx);

  // Hälsokoll vid uppstart. Icke-blockerande: Freya aktiveras även om Ollama
  // är nere, och läget syns som en statusrad bara när något saknas.
  initHealthState(ctx);

  // Tillägget körs vidare när mappen blir betrodd (supported: "limited"), så
  // statusraden måste sluta säga "agent paused" av sig själv. Utan detta står
  // det kvar tills nästa fönster -- och då ser det ut som att knappen inte
  // gjorde något.
  ctx.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void refreshHealth();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.setKeys", async () => {
      await clearKeys(ctx);
      const ok = await promptAndStoreKeys(ctx);
      if (ok) {
        await refreshCloudKeyState(ctx);
        void refreshHealth();
        vscode.window.showInformationMessage(
          "Freya: Cloudflare keys stored in the OS keychain."
        );
      }
    }),
    vscode.commands.registerCommand("freya.clearKeys", async () => {
      await clearKeys(ctx);
      await refreshCloudKeyState(ctx);
      void refreshHealth();
      vscode.window.showInformationMessage("Freya: keys deleted.");
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
          `Freya: Ollama is responding on ${url} and all models are present.`
        );
        return;
      }
      // Panelen är rätt yta för instruktioner (markdown, kopierbar kodrad).
      // Notifieringen är bara vägvisaren dit.
      const open = await vscode.window.showWarningMessage(
        health.reachable
          ? "Freya: an Ollama model is missing."
          : `Freya: Ollama is not responding on ${url}.`,
        "Show in chat"
      );
      if (open === "Show in chat") {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: "@freya hello",
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
        `Freya chats via ${backend} (${model}). Autocomplete always runs locally.`
      );
    })
  );
}

export function deactivate(): void {
  // Allt ligger i ctx.subscriptions.
}
