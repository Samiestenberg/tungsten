import * as vscode from "vscode";
import { registerParticipant } from "./participant.js";
import { registerAutocomplete } from "./autocomplete.js";
import { clearKeys, promptAndStoreKeys, chatBackend } from "./config.js";

export function activate(ctx: vscode.ExtensionContext): void {
  registerParticipant(ctx);
  registerAutocomplete(ctx);

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
