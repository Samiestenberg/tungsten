// FAS C6: guide-chatten. 3B, lokal, och DEN ENDA aktiva chat-lanen.
//
// VAD DEN HÄR CHATTEN ÄR, OCH VAD DEN INTE ÄR.
//
// Den är en GUIDE till editorn. Den svarar på "hur slår jag på autocomplete",
// "vad gör Ctrl+K Ctrl+I", "vad är skillnaden mellan de två modellerna", och
// på små kodfrågor. Den är INTE en kodagent, den läser inte filer, den skriver
// inte filer, den kör inga kommandon och den har inga verktyg.
//
// Det är ett medvetet val och inte en begränsning vi ber om ursäkt för. En 3B
// som positioneras som avancerad kodagent gör två saker fel: den lovar mer än
// den kan hålla, och den drar användaren till fel yta. Riktiga kodändringar
// hör hemma i inline edit och i quick-fixen -- där finns markeringen,
// felmeddelandet och diffen att godkänna, alltså allt som gör svaret
// användbart. Chatten pekar dit i stället för att försöka själv.
//
// ETT SKOTT PER TUR. Historiken skickas med som kontext, men det är fortfarande
// EN request som ger EN text tillbaka. Ingen loop, inga verktyg, inget att
// feltolka.
import * as vscode from "vscode";
import {
  instructAvailable,
  instructOneShot,
  INSTRUCT_MISSING,
  type InstructTurn,
} from "./instructModel.js";
import { GUIDE_SYSTEM } from "./guidePrompt.js";

// Prompten bor i guidePrompt.ts -- delad ordagrant med vscode.lm-providern,
// och testad mot package.json så guiden inte kan hänvisa till kommandon och
// inställningar som inte finns. Läs filhuvudet där: formuleringen är mätt
// fram, inte skriven på känsla.

/** Hur många tidigare turer som följer med. 3B har 8192 tokens totalt. */
const MAX_HISTORY_TURNS = 6;

/** Tak per svar. Chatten ska vara kort -- se prompten. */
const MAX_TOKENS = 500;

/**
 * VS Codes chat-historik till modellens format.
 *
 * Bara text tas med. Verktygsanrop finns inte i den här lanen, och äldre turer
 * från en tidigare agent-session ska inte återuppväckas som instruktioner.
 */
export function historyFromContext(
  context: vscode.ChatContext
): InstructTurn[] {
  const turns: InstructTurn[] = [];

  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      if (turn.prompt.trim()) {
        turns.push({ role: "user", content: turn.prompt.trim() });
      }
      continue;
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) =>
          part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ""
        )
        .join("")
        .trim();
      if (text) {
        turns.push({ role: "assistant", content: text });
      }
    }
  }

  // Senaste turerna, och alltid ett jämnt par så historiken börjar på en
  // användartur. En historik som börjar med ett assistentsvar utan frågan
  // före förvirrar en liten modell mer än den hjälper.
  const trimmed = turns.slice(-MAX_HISTORY_TURNS);
  while (trimmed.length && trimmed[0].role === "assistant") {
    trimmed.shift();
  }
  return trimmed;
}

export const FREYA_ID = "tungsten.freya";

export function registerGuideChat(ctx: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    FREYA_ID,
    async (request, context, response, token) => {
      // INGEN TRUST-GRIND HÄR, till skillnad från den gamla agenten. Den
      // behövdes för att agenten skrev filer och körde kommandon i en mapp
      // användaren inte litade på. Guiden gör ingetdera: den läser bara det
      // användaren själv skrev i rutan. Grinden hade bara stängt av en
      // hjälpfunktion i precis det läge en ny användare behöver den.

      if (!instructAvailable()) {
        response.markdown(INSTRUCT_MISSING);
        return { errorDetails: { message: "Freya: no local instruct model" } };
      }

      const prompt = request.prompt.trim();
      if (!prompt) {
        response.markdown(
          "Ask me about the editor -- settings, keybinds, what a feature does -- " +
            "or a small coding question."
        );
        return {};
      }

      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());

      try {
        const answer = await instructOneShot({
          system: GUIDE_SYSTEM,
          history: historyFromContext(context),
          user: prompt,
          maxTokens: MAX_TOKENS,
          // Chatt är den enda ytan där lite variation är önskvärd: ett
          // ordagrant identiskt svar på en omformulerad fråga läser som att
          // ingen lyssnade.
          temperature: 0.3,
          signal: ac.signal,
          onDelta: (chunk) => {
            if (!token.isCancellationRequested) {
              response.markdown(chunk);
            }
          },
        });

        if (!answer?.trim()) {
          response.markdown(
            "I had no answer for that. Try asking about a specific setting or command."
          );
        }
      } catch (err: any) {
        if (token.isCancellationRequested || err?.name === "AbortError") {
          return {};
        }
        const message = String(err?.message ?? err);
        response.markdown(`\n\n**Error:** ${message}`);
        return { errorDetails: { message } };
      } finally {
        sub.dispose();
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
