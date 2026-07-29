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
  instructAvailable,
  instructOneShot,
  INSTRUCT_MISSING,
  type InstructTurn,
} from "./instructModel.js";
import { instructState } from "./instructServer.js";
import { GUIDE_SYSTEM } from "./guidePrompt.js";

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
      const modelName = instructState().endpoint?.modelName ?? "Qwen2.5-Coder-3B-Instruct";
      return [
        {
          id: "freya-local-instruct",
          name: "Freya (local 3B)",
          family: "freya",
          version: "1",
          // 3B kör med 8192 tokens kontext (freya.instruct.contextSize).
          // Siffrorna här ska spegla det -- workbenchen trimmar kontext mot
          // dem, och ett för högt tal ger avhuggna svar i stället för trimmade.
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
      if (!instructAvailable()) {
        progress.report(new vscode.LanguageModelTextPart(INSTRUCT_MISSING));
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
          history,
          user,
          maxTokens: 1000,
          temperature: 0.3,
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
