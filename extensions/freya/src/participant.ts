// VILANDE. REGISTRERAS INTE. Se FAS R.
//
// ─────────────────────────────────────────────────────────────────────────
// Det här var Freyas agent-participant: en verktygsloop mot en tung modell
// (qwen2.5-coder:14b via Ollama, eller qwen3-30b via Cloudflare Workers AI).
// Den ersattes av den lokala 3B-guiden i guideChat.ts, som är den enda
// chat-lane som registreras i default-bygget.
//
// VARFÖR DEN ÄR BORTA SOM DEFAULT, inte som en smaksak:
//
//   * 14B-vägen krävde att användaren hämtade 9 GB innan chatten fungerade --
//     alltså precis motsatsen till "allt kör lokalt dag ett".
//   * Molnvägen krävde ett konto, egna nycklar och skickade koden ut ur
//     maskinen.
//   * Verktygsloopen var dessutom den enskilt största felkällan i hela
//     produkten. Modellen skrev verktygsanrop som prosa-JSON i ```-block,
//     halva anrop läckte ut i chatten som om de vore svaret, och verktyget
//     kördes aldrig. Det finns nitton tester i toolCallParsing.test.ts som
//     är byggda av de felen. Instruct-lanen eliminerar hela klassen genom att
//     inte ha några verktyg alls.
//
// VARFÖR FILEN ÄNDÅ ÄR KVAR: beslutet om en framtida opt-in-moln-tier är
// PARKERAT, inte avslaget, och den här koden är den granskade versionen av
// hur en agentyta såg ut. Att kasta den och skriva den igen vore slöseri.
// Den importeras inte av något i den aktiva kodvägen och registreras inte i
// extension.ts. cloud.ts har samma status och beskriver hur man väcker den.
// ─────────────────────────────────────────────────────────────────────────
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
import { workspaceRoot } from "./config.js";
import { createCloudProvider } from "./cloud.js";
import { agentPausedMarkdown, isTrusted } from "./trust.js";

// Participant-id:t ägs numera av guideChat.ts. Det står kvar här bara för att
// filen ska vara komplett om tiern väcks; två registreringar av samma id
// samtidigt går inte.
export const DORMANT_AGENT_ID = "tungsten.freya";

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
    DORMANT_AGENT_ID,
    async (request, context, response, token) => {
      // Trust-grinden ligger FÖRST, före allt annat. Agenten kan skriva filer
      // och köra kommandon; i en obetrodd mapp ska den inte ens nå modellen.
      // Att svara här i stället för att låta tillägget vara oregistrerat är
      // hela poängen: användaren får ett besked med en knapp, inte tystnad.
      if (!isTrusted()) {
        response.markdown(agentPausedMarkdown());
        return {};
      }

      const workdir = workspaceRoot();
      if (!workdir) {
        response.markdown(
          "Open a folder first -- Freya works with files and needs a project root."
        );
        return {};
      }

      // Modellen kommer ur den VILANDE moln-tiern. I default-bygget returnerar
      // createCloudProvider() undefined utan att ha rört några nycklar, så den
      // här handlern kan inte nå ut ur maskinen ens om någon råkade registrera
      // den. Se cloud.ts.
      const provider = await createCloudProvider(ctx);
      if (!provider) {
        response.markdown(
          "The cloud tier is off in this build. Everything runs on the two " +
            "local models instead -- ask me about the editor, or use Ctrl+K Ctrl+I " +
            "to rewrite a selection."
        );
        return { errorDetails: { message: "Freya: cloud tier disabled" } };
      }

      response.progress("Workers AI");

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
              "Freya wants to run a command",
              { modal: true, detail: command },
              "Run"
            );
            return answer === "Run";
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
        response.markdown(`\n\n**Error:** ${message}`);
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
