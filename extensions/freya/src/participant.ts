// Freya som chat participant. Panelen pratar med DEN HÄR koden, inte med
// VS Codes inbyggda modell-providers.
//
// Två saker att vara noga med:
//
// 1. Vi använder aldrig vscode.lm — varken språkmodellerna eller
//    vscode.lm.tools. Det är avsiktligt. vscode.lm.tools innehåller
//    workbenchens automationsverktyg (MCP-servrar, type_in_page m.fl.) och de
//    ska Freya inte ha. Agenten kör bara TOOL_SCHEMAS ur core/tools.ts:
//    read_file, write_file, edit_file, list_files, search_files, run_command.
//    Eftersom vi går direkt mot ModelProvider finns automationsverktygen inte
//    ens i modellens verktygslista — det är en egenskap av konstruktionen, inte
//    en filtrering som kan glömmas bort.
//
// 2. Historiken hålls per chat-session via ChatContext.history, inte i en
//    modulglobal. Flera sessioner samtidigt ska inte blandas.
import * as vscode from "vscode";
import { runAgent } from "./core/agent.js";
import { createChatProvider, workspaceRoot, chatBackend, ollamaUrl, chatModel } from "./config.js";
import { ollamaGuidance, probeOllama } from "./health.js";

export const FREYA_ID = "tungsten.freya";

// Bygger om VS Codes chat-historik till agentens meddelandeformat.
// Vi tar bara med text; verktygsanropen i tidigare turer är redan utförda och
// deras resultat finns inte kvar i ChatContext.
function historyFromContext(context: vscode.ChatContext): any[] {
  const messages: any[] = [];
  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      if (turn.prompt.trim()) {
        messages.push({ role: "user", content: turn.prompt });
      }
      continue;
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) =>
          part instanceof vscode.ChatResponseMarkdownPart
            ? part.value.value
            : ""
        )
        .join("")
        .trim();
      if (text) {
        messages.push({ role: "assistant", content: text });
      }
    }
  }
  return messages;
}

function toolLine(name: string, input: any): string {
  const detail =
    typeof input?.path === "string"
      ? input.path
      : typeof input?.command === "string"
        ? input.command
        : typeof input?.query === "string"
          ? input.query
          : "";
  return detail ? `${name} · ${detail}` : name;
}

export function registerParticipant(ctx: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    FREYA_ID,
    async (request, context, response, token) => {
      const workdir = workspaceRoot();
      if (!workdir) {
        response.markdown(
          "Öppna en mapp först — Freya arbetar med filer och behöver en projektrot."
        );
        return {};
      }

      // Hälsokoll INNAN vi försöker prata med modellen. Utan den fick
      // användaren antingen tystnad eller ett raw fetch-fel när Ollama inte
      // körde; nu blir det en rad i panelen med exakt kommandot som fixar det.
      if (chatBackend() === "ollama") {
        const url = ollamaUrl();
        const health = await probeOllama(url);
        const guidance = ollamaGuidance(health, [chatModel()], url);
        if (guidance) {
          response.markdown(guidance);
          return { errorDetails: { message: "Freya: Ollama är inte redo" } };
        }
      }

      const { provider, problem, label } = await createChatProvider(ctx);
      if (!provider) {
        response.markdown(problem ?? "Ingen modell konfigurerad.");
        return { errorDetails: { message: "Freya: ingen modell konfigurerad" } };
      }

      response.progress(label);

      try {
        await runAgent({
          provider,
          prompt: request.prompt,
          workdir,
          history: historyFromContext(context),
          maxSteps: vscode.workspace
            .getConfiguration("freya")
            .get<number>("chat.maxSteps"),
          confirm: async (command: string) => {
            if (token.isCancellationRequested) return false;
            const answer = await vscode.window.showWarningMessage(
              "Freya vill köra ett kommando",
              { modal: true, detail: command },
              "Kör"
            );
            return answer === "Kör";
          },
          onEvent: (e) => {
            if (token.isCancellationRequested) return;
            switch (e.type) {
              case "delta":
                response.markdown(e.text);
                break;
              case "text":
                response.markdown(e.text);
                break;
              case "tool":
                response.progress(toolLine(e.name, e.input));
                break;
              case "result":
              case "done":
                break;
            }
          },
        });
      } catch (err: any) {
        const message = String(err?.message ?? err);
        response.markdown(`\n\n**Fel:** ${message}`);
        return { errorDetails: { message } };
      }

      return {};
    }
  );

  participant.iconPath = vscode.Uri.joinPath(
    ctx.extensionUri,
    "media",
    "freya.svg"
  );

  ctx.subscriptions.push(participant);
}
