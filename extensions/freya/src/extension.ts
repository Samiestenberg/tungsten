import * as vscode from "vscode";
import * as path from "path";
import { setDownloadRoot } from "./runtimeLayout.js";
import { registerModelDownload } from "./modelDownload.js";
import { registerGuideChat } from "./guideChat.js";
import { registerLanguageModel } from "./languageModel.js";
import { registerAutocomplete } from "./autocomplete.js";
import { autocompleteModel, lightBackend, ollamaUrl } from "./config.js";
import { initHealthState, refreshHealth } from "./healthState.js";
import { ollamaGuidance, probeOllama } from "./health.js";
import { registerCommitMessage } from "./commitMessage.js";
import { registerSecretsGuard } from "./secretsGuard.js";
import { registerStagedSecretScan } from "./secretsStaged.js";
import { initLocalServer, localState } from "./localServer.js";
import { initInstructServer, instructInstalled, instructState } from "./instructServer.js";
import { registerExplain } from "./explain.js";
import { registerNextEdit } from "./fim/nextEdit.js";
import { registerSyntaxFix } from "./fim/syntaxFix.js";
import { registerInlineEdit } from "./inlineEdit.js";
import { registerSemanticFix } from "./semanticFix.js";
import { registerGenerateTests } from "./generateTests.js";
import { registerRefactorPresets } from "./refactorPresets.js";
import { registerNameThings } from "./nameThings.js";
import { registerCodeReview } from "./codeReview.js";
import { registerPreview } from "./preview.js";

export function activate(ctx: vscode.ExtensionContext): void {
  // FÖRST AV ALLT: var hämtade modeller får ligga.
  //
  // Den lilla installern (byggd med FREYA_BUNDLE_INSTRUCT=0) har ingen 3B med
  // sig, så den hämtas vid första användningen. Den kan inte skrivas till
  // resources/app -- den mappen ligger under Program Files och är skrivskyddad
  // för en användarinstallation. globalStorage är skrivbar och överlever
  // uppdateringar.
  //
  // Måste ske INNAN någon runtime-sökning görs, annars är mappen osynlig för
  // findRuntime() i det här fönstret.
  setDownloadRoot(path.join(ctx.globalStorageUri.fsPath, "freya-runtime"));
  // ALLT NEDAN REGISTRERAS ÄVEN I EN OBETRODD MAPP. Tillägget deklarerar
  // untrustedWorkspaces.supported: "limited", så activate() körs direkt när
  // fönstret öppnas -- annars startade varken de inbäddade modellerna eller
  // något som kunde förklara varför.
  //
  // TRUST-GRINDEN FÖRSVANN I FAS R, och det var inte en försvagning. Den
  // fanns för AGENTEN: en loop som skrev filer, körde kommandon och skickade
  // arbetsytans innehåll till molnet eller till en Ollama vi inte startat. Den
  // agenten är retirerad. Det som är kvar läser bara det användaren själv
  // markerat och skickar det till en process vi startat på 127.0.0.1.
  //
  // Det som spärren FAKTISKT skyddade -- att en fientlig arbetsyta pekar om
  // vart texten går eller vilken binär vi startar -- ligger kvar och gäller
  // BÅDA lanerna: se restrictedConfigurations i package.json.

  // Den inbäddade 1.5B-servern startas FÖRST men utan await: allt högfrekvent
  // (komplettering, next-edit, syntaxfix, commit-rubriker) går mot den, och
  // den ska vara på väg upp medan resten registreras.
  initLocalServer(ctx, () => void refreshHealth());

  // 3B-instruct-lanen får sin livscykel registrerad här men startas INTE nu.
  // Den spawnas vid första instruct-anropet och laddas ur efter ~5 minuters
  // tystnad. Skälet är minne: 1.5B + 3B residenta samtidigt lämnar inte plats
  // åt editorn på en 8 GB-maskin. Se instructServer.ts.
  initInstructServer(ctx, () => void refreshHealth());

  // Ordning spelar roll: utan en registrerad vscode.lm-modell avvisas varje
  // chat-request med "Language model unavailable" innan Freyas handler nås.
  registerLanguageModel(ctx);
  // Chat-lanen är den LOKALA 3B-guiden. Agent-loopen i participant.ts är
  // vilande och registreras inte -- se filhuvudet där och i cloud.ts.
  registerGuideChat(ctx);
  registerAutocomplete(ctx);
  registerNextEdit(ctx);
  registerSyntaxFix(ctx);
  registerCommitMessage(ctx);
  registerSecretsGuard(ctx);
  registerStagedSecretScan(ctx);
  registerExplain(ctx);
  // Diff-förhandsvisningen måste vara registrerad innan någon yta vill visa
  // en. Den är den ENDA vägen från "modellen föreslog något" till "filen
  // ändrades" -- se preview.ts.
  registerPreview(ctx);
  registerInlineEdit(ctx);
  registerSemanticFix(ctx);
  registerGenerateTests(ctx);
  registerRefactorPresets(ctx);
  registerNameThings(ctx);
  registerCodeReview(ctx);
  registerModelDownload(ctx);

  // MOLN-TIERN REGISTRERAS INTE. cloud.registerCloudCommands() anropas
  // medvetet inte här: ett kommando som ber om Cloudflare-nycklar hör inte
  // hemma i en app som lovar att inte prata med molnet, och ett registrerat
  // kommando syns i paletten oavsett om det gör något. Se cloud.ts.

  // Hälsokoll vid uppstart. Icke-blockerande.
  initHealthState(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.checkOllama", async () => {
      // Ollama behövs BARA av den som själv satt freya.light.backend till
      // "ollama". Default-bygget behöver ingenting installerat, så kollen
      // säger det i stället för att låtsas att något saknas.
      if (lightBackend() === "embedded") {
        vscode.window.showInformationMessage(
          "Freya runs entirely on the models built into Tungsten. Ollama is not needed."
        );
        return;
      }
      const url = ollamaUrl();
      const health = await probeOllama(url);
      await refreshHealth();
      const guidance = ollamaGuidance(health, [autocompleteModel()], url);
      if (!guidance) {
        vscode.window.showInformationMessage(
          `Freya: Ollama is responding on ${url} and the completion model is present.`
        );
        return;
      }
      const open = await vscode.window.showWarningMessage(
        health.reachable
          ? "Freya: the Ollama completion model is missing."
          : `Freya: Ollama is not responding on ${url}.`,
        "Show in chat"
      );
      if (open === "Show in chat") {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: "@freya how do I switch completion back to the built-in model?",
        });
      }
    }),

    vscode.commands.registerCommand("freya.showBackend", () => {
      const fim =
        lightBackend() === "embedded"
          ? (localState().endpoint?.modelName ?? "the embedded 1.5B (starting)")
          : `your own Ollama (${autocompleteModel()})`;
      const instruct = !instructInstalled()
        ? "not installed in this build"
        : (instructState().endpoint?.modelName ?? "3B instruct (loads on first use)");

      vscode.window.showInformationMessage(
        `Completion, next edit, syntax fix, commit messages: ${fim}\n` +
          `Explain, rewrite, fix, tests, chat: ${instruct}\n\n` +
          "Everything runs on this machine. No account, no network.",
        { modal: true }
      );
    })
  );
}

export function deactivate(): void {
  // Allt ligger i ctx.subscriptions.
}
