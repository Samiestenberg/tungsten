// Freya som språkmodell-leverantör (vendor "freya").
//
// VARFÖR DEN HÄR FILEN FINNS: extHostChatAgents2.getModelForRequest kastar
// "Language model unavailable" om det inte finns EN ENDA registrerad
// vscode.lm-modell -- oavsett om participanten faktiskt tänker använda den.
// Utan detta kommer en chat-request aldrig fram till Freyas handler.
//
// Vi löser det genom att servera vscode.lm med VÅRA egna modeller i stället
// för att luta oss mot VS Codes inbyggda providers. Modellväljaren visar
// Freyas modeller (BYOK/lokalt), inte "sign in to use Copilot".
//
// Agent-loopen i participant.ts använder INTE den här vägen: den går direkt
// mot ModelProvider med Freyas egna verktyg. Den här providern är den enkla
// text-in/text-ut-ytan som vscode.lm-API:t förväntar sig.
import * as vscode from "vscode";
import { createChatProvider, chatBackend } from "./config.js";

export const FREYA_VENDOR = "freya";

// Plattar ut vscode.lm-meddelanden till agentkärnans format.
function toAgentMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): any[] {
  const out: any[] = [];
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
    const role =
      m.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : "user";
    out.push({ role, content: text });
  }
  return out;
}

export function registerLanguageModel(ctx: vscode.ExtensionContext): void {
  const provider: vscode.LanguageModelChatProvider = {
    async provideLanguageModelChatInformation(_options, _token) {
      const backend = chatBackend();
      const cfg = vscode.workspace.getConfiguration("freya");
      const id = backend === "ollama" ? "freya-ollama" : "freya-workersai";
      const modelName =
        backend === "ollama"
          ? cfg.get<string>("chat.ollamaModel") || "qwen2.5-coder:14b"
          : cfg.get<string>("chat.workersAiModel") ||
            "@cf/qwen/qwen3-30b-a3b-fp8";

      return [
        {
          id,
          name: `Freya (${modelName})`,
          family: "freya",
          version: "1",
          maxInputTokens: 24000,
          maxOutputTokens: 8000,
          capabilities: { toolCalling: true, imageInput: false },
          isBYOK: true,
          isDefault: true,
          isUserSelectable: true,
          detail: backend === "ollama" ? "Lokal (Ollama)" : "Cloudflare Workers AI",
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
      const { provider: model, problem } = await createChatProvider(ctx);
      if (!model) {
        progress.report(
          new vscode.LanguageModelTextPart(problem ?? "Ingen modell konfigurerad.")
        );
        return;
      }

      const agentMessages = toAgentMessages(messages);
      let streamed = false;

      // Inga verktyg här. Verktyg hör till agent-loopen i participant.ts.
      const res = await model.send(agentMessages, [], (chunk) => {
        if (!token.isCancellationRequested) {
          streamed = true;
          progress.report(new vscode.LanguageModelTextPart(chunk));
        }
      });

      // Providers utan streaming-stöd lämnar allt i ett textblock på slutet.
      if (!streamed) {
        const text = res.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) {
          progress.report(new vscode.LanguageModelTextPart(text));
        }
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
