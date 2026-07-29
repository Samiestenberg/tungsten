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
import { instructState } from "./instructServer.js";
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
          // ÖPPET FEL: DE HÄR TVÅ TALEN ÄR FÖR STORA FÖR MODELLEN VI SKICKAR.
          //
          // Det stod tidigare här att "3B kör med 8192 tokens kontext
          // (freya.instruct.contextSize)" och att siffrorna ska spegla det.
          // Premissen är fel. Granite-3B-Code-Instruct-2k är tränad på 2048
          // tokens, och llama-server KAPAR till den gränsen -- ur serverns egen
          // logg vid uppstart, med --ctx-size 8192:
          //
          //   W llama_context: n_ctx_seq (8192) > n_ctx_train (2048)
          //     -- possible training context overflow
          //   W srv load_model: the slot context (8192) exceeds the training
          //     context of the model (2048) - capping
          //   I srv load_model: initializing, n_slots = 4, n_ctx_slot = 2048
          //
          // Inställningen på 8192 är alltså inte bara optimistisk, den är
          // ouppnåelig med den här modellen. Och följden är VÄRRE än den
          // avhuggning som den gamla kommentaren oroade sig för: llama-server
          // trimmar inte, den vägrar. Uppmätt mot ett riktigt förstagångsbygge:
          //
          //   POST /completion, 5601 tokens prompt  ->  HTTP 400
          //   {"error":{"message":"request (5601 tokens) exceeds the available
          //     context size (2048 tokens)","type":"exceed_context_size_error"}}
          //
          // 5601 ligger UNDER maxInputTokens 6000. Workbenchen trimmar alltså
          // till ett tal den tror är lagligt, och får ett hårt fel tillbaka.
          //
          // KONTROLLERAT ATT DET INTE ÄR VÅRA FLAGGOR: `--parallel 1` ger
          // n_slots = 1 men fortfarande n_ctx_slot = 2048, och FIM-lanen med
          // --ctx-size 4096 får 4096 per slot (1.5B:n är tränad på mer). Det är
          // modellens träningskontext som sätter taket, inget vi konfigurerar.
          //
          // ÅTGÄRDEN ÄR INTE SKRIVEN HÄR MED FLIT, för det är två olika beslut:
          //   (a) gör talen sanna -- ca 1400 in / 600 ut ryms i 2048. Ärligt,
          //       men det halverar mer än en fjärdedel av det chatten lovar.
          //   (b) byt till en Granite-variant med större kontext (8k/128k
          //       finns). Då byts också GGUF:en i R2, den pinnade sha256:n och
          //       hela den verifieringskedjan -- alltså ett eget arbetspass.
          // Talen står kvar orörda tills valet är gjort, så att ingen tror att
          // problemet är löst av att en konstant flyttats utan ett packat bygge
          // bakom sig.
          // ─────────────────────────────────────────────────────────────────
          maxInputTokens: 6000,
          maxOutputTokens: 1000,
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
          maxTokens: 1000,
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
