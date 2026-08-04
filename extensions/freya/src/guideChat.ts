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
import * as path from "path";
import {
  ensureInstructReady,
  instructOneShot,
  instructUnavailableMessage,
  clampToLines,
  type InstructTurn,
} from "./instructModel.js";
import { GUIDE_SHOTS, GUIDE_STOP, GUIDE_SYSTEM, formatUserPromptWithContext } from "./guidePrompt.js";
import { instructMaxInputTokens } from "./instructServer.js";

export function buildPromptWithEditorContext(prompt: string): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor?.document) {
    return prompt;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") {
    return prompt;
  }

  const fileName = path.basename(doc.fileName || "untitled");
  const languageId = doc.languageId || "plaintext";
  const sel = editor.selection;
  let snippet = "";
  if (sel && !sel.isEmpty) {
    snippet = doc.getText(sel).trim();
  } else {
    snippet = doc.getText().trim();
  }

  if (!snippet) {
    return prompt;
  }

  const clampedSnippet = clampToLines(snippet, 1200).trim();
  return formatUserPromptWithContext(prompt, {
    fileName,
    languageId,
    snippet: clampedSnippet,
  });
}

// Prompten bor i guidePrompt.ts -- delad ordagrant med vscode.lm-providern,
// och testad mot package.json så guiden inte kan hänvisa till kommandon och
// inställningar som inte finns. Läs filhuvudet där: formuleringen är mätt
// fram, inte skriven på känsla.

/**
 * Grovt tak på hur många tidigare turer som ens övervägs.
 *
 * Här stod "3B har 8192 tokens totalt". Det var fel, och det är samma falska
 * premiss som gav maxInputTokens 6000 i languageModel.ts:
 * Granite-3B-Code-Instruct-2k är tränad på 2048 och llama-server kapar dit.
 * Sex långa turer plus GUIDE_SYSTEM, GUIDE_SHOTS och svarsutrymmet ryms inte i
 * 2048 -- och när det inte ryms trimmar servern inte, den svarar HTTP 400.
 *
 * Turgränsen är därför bara ett tak. Den riktiga gränsen räknas i
 * fitWithinBudget() nedan, i tokens.
 */
const MAX_HISTORY_TURNS = 6;

/** Tak per svar. Chatten ska vara kort -- se prompten. */
const MAX_TOKENS = 500;

/**
 * Samma grova uppskattning som providerns provideTokenCount: ~3,5 tecken per
 * token. Vi har ingen lokal tokenizer. Den ska vara IDENTISK med providerns --
 * annars trimmar de två chatt-ytorna olika mycket för samma modell.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Släpper de äldsta turerna tills historiken plus frågan ryms i budgeten.
 *
 * Budgeten kommer från instructMaxInputTokens(), som räknar bakåt från den
 * kontext servern faktiskt ger -- se instructServer.ts. Guide-prompten och
 * svarsutrymmet är redan avdragna där, så det som återstår här är vad
 * historiken och frågan tillsammans får kosta.
 *
 * Äldst ryker först, och resultatet börjar alltid på en användartur: en
 * historik som inleds med ett assistentsvar utan frågan före förvirrar en liten
 * modell mer än den hjälper.
 */
function fitWithinBudget(
  turns: InstructTurn[],
  question: string
): InstructTurn[] {
  let budget = instructMaxInputTokens() - estimateTokens(question);
  const kept: InstructTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(turns[i].content);
    if (cost > budget) {
      break;
    }
    budget -= cost;
    kept.unshift(turns[i]);
  }
  while (kept.length && kept[0].role === "assistant") {
    kept.shift();
  }
  return kept;
}

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

      // ensureInstructReady() och inte instructAvailable(): på den LILLA
      // installern finns 3B:n inte på disk vid första körningen, och rätt svar
      // på en fråga användaren nyss skrev är inte "modellen är inte installerad
      // i det här bygget -- kör fetchLocalRuntime.ts" utan en fråga om att
      // hämta den. Det gamla beskedet var dessutom en dev-träds-instruktion
      // riktad till en slutanvändare.
      //
      // Att öppna en modal här är tillåtet av samma skäl som på de fem andra
      // UI-ytorna: den kommer som svar på något användaren själv gjorde. Det är
      // hover- och CodeAction-providrarna som aldrig får göra det, för de körs
      // oavbrutet. Se ensureInstructReady() i instructModel.ts.
      if (!(await ensureInstructReady())) {
        response.markdown(instructUnavailableMessage());
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

      const fullUserPrompt = buildPromptWithEditorContext(prompt);

      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());

      try {
        const answer = await instructOneShot({
          system: GUIDE_SYSTEM,
          // FÅ-SKOTTS-EXEMPLEN FÖRST, sedan den riktiga historiken. Se
          // GUIDE_SHOTS i guidePrompt.ts: utan dem ignorerade Granite både
          // formatet och gränsen och erbjöd sig att gå igenom användarens repo.
          history: [
            ...GUIDE_SHOTS,
            ...fitWithinBudget(historyFromContext(context), fullUserPrompt),
          ],
          user: fullUserPrompt,
          maxTokens: MAX_TOKENS,
          stop: GUIDE_STOP,
          // TEMPERATUR 0, inte 0,3. Tidigare stod här att lite variation var
          // önskvärd i chatten. Det gällde när modellen följde prompten ändå;
          // med Granite kostade varje grad av drift träffsäkerhet på
          // inställningsnamn, vilket är precis det man frågar guiden om.
          temperature: 0,
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
