import type { ModelProvider, OnDelta } from "./types.js";
import { createThinkStripper } from "../think.js";

const SYSTEM = [
    "You are a coding agent that works with files.",
    "",
    "RULES:",
    "0. Run list_files first in an unfamiliar project. Never guess file names.",
  "1. ALWAYS read a file with read_file before you change it.",
    "2. Use edit_file to change existing files. NEVER write_file.",
    "3. write_file is ONLY for creating new files that do not exist.",
    "4. Preserve all content you were not explicitly asked to change.",
    "5. Never claim you did something you did not do.",
    "",
    "Be concise.",
  ].join("\n");

export class WorkersAIProvider implements ModelProvider {
  constructor(
    private accountId: string,
    private apiToken: string,
    private model: string
  ) {}

  async send(messages: any[], tools: any[], onDelta?: OnDelta) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8000,
          stream: true,
          messages: toOpenAI(messages),
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          })),
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`Workers AI ${res.status}: ${await res.text()}`);
    }

    let text = "";
    const think = createThinkStripper();
    const toolCallsByIndex = new Map<
      number,
      { id?: string; name?: string; args: string }
    >();

    await readSSE(res, (evt) => {
      const delta = evt.choices?.[0]?.delta;
      if (!delta) return;

      // qwen3 strömmar sitt "thinking" i delta.reasoning / reasoning_content.
      // Vi vill inte visa det i chatten — bara riktigt svar i delta.content.
      // Ibland läcker det ändå ut som <think>...</think> i delta.content;
      // think-strippern plockar bort det, även när taggen delas mellan chunkar.
      if (delta.content) {
        const visible = think.push(delta.content);
        if (visible) {
          text += visible;
          onDelta?.(visible);
        }
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const entry = toolCallsByIndex.get(idx) ?? { args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolCallsByIndex.set(idx, entry);
      }
    });

    const tail = think.flush();
    if (tail) {
      text += tail;
      onDelta?.(tail);
    }

    const content: any[] = [];
    if (text) content.push({ type: "text", text });

    for (const tc of toolCallsByIndex.values()) {
      let input: any = {};
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        content.push({
          type: "text",
          text: `[trasig tool-input: ${tc.args}]`,
        });
        continue;
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
        name: tc.name!,
        input,
      });
    }

    return { content };
  }
}

// Läser Server-Sent Events (OpenAI-stilens "data: {...}"-rader, avslutas
// med "data: [DONE]") och anropar onEvent för varje avkodad JSON-payload.
async function readSSE(res: Response, onEvent: (data: any) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // ignorera trasiga/ofullständiga rader
      }
    }
  }
}

// Internt format (Anthropic-stil) -> OpenAI-format
function toOpenAI(messages: any[]): any[] {
  const out: any[] = [{ role: "system", content: SYSTEM }];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      const calls = m.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      out.push({
        role: "assistant",
        content: text || "",
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    const results = m.content.filter((b: any) => b.type === "tool_result");
    if (results.length) {
      for (const r of results) {
        out.push({
          role: "tool",
          tool_call_id: r.tool_use_id,
          content: String(r.content),
        });
      }
    } else {
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      out.push({ role: "user", content: text });
    }
  }

  return out;
}