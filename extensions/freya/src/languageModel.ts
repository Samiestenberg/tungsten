// Freya som språkmodell-leverantör (vendor "freya").
//
// VARFÖR DEN HÄR FILEN FINNS: extHostChatAgents2.getModelForRequest kastar
// "Language model unavailable" om det inte finns EN ENDA registrerad
// vscode.lm-modell -- oavsett om participanten faktiskt tänker använda den.
// Utan detta kommer en chat-request aldrig fram till Freyas handler.
//
// Vi löser det genom att servera vscode.lm med VÅR EGEN modell i stället för
// att luta oss mot VS Codes inbyggda providers. Modellväljaren visar den
// inbäddade 3B:n, inte "sign in to use Copilot".
//
// EN ENDA MODELL, OCH DEN ÄR LOKAL. Tidigare visade den här providern antingen
// qwen2.5-coder:14b via Ollama eller qwen3-30b via Cloudflare Workers AI,
// beroende på om det fanns nycklar. Båda är retirerade som aktiva val: 14B
// kräver att användaren pullar 9 GB, och molnvägen kräver ett konto och skickar
// koden ut. Default-bygget kör allt lokalt, så modellväljaren ska visa exakt
// det som faktiskt kör.
//
// Ingen tool-calling deklareras. Instruct-lanen har inga verktyg -- se
// instructModel.ts -- och att påstå motsatsen här hade fått workbenchen att
// skicka verktygsscheman vi inte kan hantera.
import * as vscode from "vscode";
import {
  ensureInstructReady,
  instructOneShot,
  instructUnavailableMessage,
  type InstructTurn,
} from "./instructModel.js";
import {
  INSTRUCT_MAX_OUTPUT_TOKENS,
  instructMaxInputTokens,
  instructState,
} from "./instructServer.js";
import { GUIDE_SHOTS, GUIDE_STOP, GUIDE_SYSTEM } from "./guidePrompt.js";

export const FREYA_VENDOR = "freya";

/** Plattar ut vscode.lm-meddelanden till instruct-lanens format. */
function toTurns(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): { history: InstructTurn[]; user: string } {
  const turns: InstructTurn[] = [];

  for (const m of messages) {
    const text = m.content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part && typeof part.value === "string") return part.value;
        return "";
      })
      .join("")
      .trim();
    if (!text) continue;
    turns.push({
      role:
        m.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "user",
      content: text,
    });
  }

  // Sista användarturen är frågan; resten är historik. Slutar listan på ett
  // assistentsvar finns ingen fråga att svara på.
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  const history = turns.slice(0, turns.lastIndexOf(lastUser ?? turns[0]));
  return { history, user: lastUser?.content ?? "" };
}

export function registerLanguageModel(ctx: vscode.ExtensionContext): void {
  const provider: vscode.LanguageModelChatProvider = {
    async provideLanguageModelChatInformation(_options, _token) {
      // Namnet på GGUF:en när modellen är laddad; annars modellens namn som
      // fallback-text i väljaren.
      const modelName = instructState().endpoint?.modelName ?? "Granite-3B-Code-Instruct";
      return [
        {
          id: "freya-local-instruct",
          name: "Freya (local 3B)",
          family: "freya",
          version: "1",
          // ─────────────────────────────────────────────────────────────────
          // TALEN ÄR HÄRLEDDA UR KONTEXTEN, INTE VALDA. Se instructServer.ts.
          //
          // Här stod tidigare maxInputTokens 6000 / maxOutputTokens 1000, på
          // premissen att 3B kör med 8192 tokens. Den premissen var fel:
          // Granite-3B-Code-Instruct-2k är tränad på 2048 och llama-server kapar
          // dit. Följden var inte avhuggna svar utan ett HÅRT fel -- uppmätt mot
          // ett riktigt förstagångsbygge:
          //
          //   POST /completion, 5601 tokens prompt  ->  HTTP 400
          //   {"error":{"message":"request (5601 tokens) exceeds the available
          //     context size (2048 tokens)","type":"exceed_context_size_error"}}
          //
          // 5601 låg UNDER 6000. Workbenchen trimmade alltså till ett tal den
          // trodde var lagligt och fick ett fel tillbaka i stället för ett svar.
          //
          // Nu kommer båda talen från instructMaxInputTokens() respektive
          // INSTRUCT_MAX_OUTPUT_TOKENS, som räknar bakåt från den kontext
          // servern faktiskt ger: kontext minus guide-prompten minus
          // genereringen minus marginal för att vår tokenuppskattare är en
          // gissning. Med den modell vi skickar blir det 868 in / 600 ut.
          //
          // Höjer någon freya.instruct.contextSize för en modell som klarar mer
          // följer talen med. Det är hela poängen med att de räknas här.
          // ─────────────────────────────────────────────────────────────────
          maxInputTokens: instructMaxInputTokens(),
          maxOutputTokens: INSTRUCT_MAX_OUTPUT_TOKENS,
          capabilities: { toolCalling: false, imageInput: false },
          isBYOK: false,
          isDefault: true,
          isUserSelectable: true,
          detail: `Local, on this machine · ${modelName}`,
        } satisfies vscode.LanguageModelChatInformation,
      ];
    },

    async provideLanguageModelChatResponse(
      _model,
      messages,
      _options,
      progress,
      token
    ) {
      // INGEN TRUST-GRIND. Den gamla providern vägrade svara i en obetrodd
      // mapp, och det var rätt då: svaret gick till molnet eller till en
      // Ollama-instans vi inte startat. Nu går det till en process vi själva
      // startat på 127.0.0.1 med innehåll användaren själv skrev in. Det finns
      // inget att läcka.
      // Samma resonemang som i guideChat.ts: ytan ar anvandarinitierad, sa den
      // far erbjuda hamtningen i stallet for att saga "inte installerad".
      // provideLanguageModelChatInformation ovan gor det INTE -- den fragar bara
      // instructState() och far aldrig oppna en dialog.
      if (!(await ensureInstructReady())) {
        progress.report(new vscode.LanguageModelTextPart(instructUnavailableMessage()));
        return;
      }

      const { history, user } = toTurns(messages);
      if (!user) {
        return;
      }

      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());
      try {
        await instructOneShot({
          system: GUIDE_SYSTEM,
          // Samma få-skotts-exempel och samma stopp som chat-participanten.
          // De två ytorna svarar som SAMMA guide; glider de isär svarar de
          // olika på samma fråga. Se guidePrompt.ts.
          history: [...GUIDE_SHOTS, ...history],
          user,
          // Samma tal som maxOutputTokens ovan. Står de isär lovar vi ett
          // svarsutrymme vi sedan inte ber om -- eller ber om mer än vi räknat
          // in i budgeten, vilket är det som spränger kontexten.
          maxTokens: INSTRUCT_MAX_OUTPUT_TOKENS,
          stop: GUIDE_STOP,
          temperature: 0,
          signal: ac.signal,
          onDelta: (chunk) => {
            if (!token.isCancellationRequested) {
              progress.report(new vscode.LanguageModelTextPart(chunk));
            }
          },
        });
      } finally {
        sub.dispose();
      }
    },

    // Grov uppskattning. Vi har ingen tokenizer lokalt och qwen ligger runt
    // ~3,5 tecken/token för kod och blandad svenska/engelska. Används bara
    // för att trimma kontext, inte för fakturering.
    async provideTokenCount(_model, text, _token) {
      const s =
        typeof text === "string"
          ? text
          : text.content
              .map((p: any) => (typeof p === "string" ? p : (p?.value ?? "")))
              .join("");
      return Math.ceil(s.length / 3.5);
    },
  };

  ctx.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(FREYA_VENDOR, provider)
  );
}
