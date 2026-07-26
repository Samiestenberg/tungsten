import type { ModelProvider, OnDelta } from "./types.js";
import { createThinkStripper } from "../think.js";

const SYSTEM = [
  "Du är en kodagent som arbetar med filer.",
  "",
  "REGLER:",
  "0. Kör list_files först i ett okänt projekt. Gissa aldrig filnamn.",
  "1. Läs ALLTID en fil med read_file innan du ändrar den.",
  "2. Använd edit_file för att ändra befintliga filer. ALDRIG write_file.",
  "3. write_file används BARA för att skapa nya filer som inte finns.",
  "4. Bevara allt innehåll du inte uttryckligen blivit ombedd att ändra.",
  "5. Påstå aldrig att du gjort något du inte gjort.",
  "",
  "Var kortfattad.",
].join("\n");

export class OllamaProvider implements ModelProvider {
  constructor(
    private baseUrl: string,
    private model: string
  ) {}

  async send(messages: any[], tools: any[], onDelta?: OnDelta) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
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
    });

    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    }

    let text = "";
    let nativeToolCalls: any[] = [];

    // qwen2.5-coder skriver ofta ett verktygsanrop som rått JSON-innehåll
    // (se parseFallbackToolCalls nedan) i stället för att fylla tool_calls.
    // Vi vet inte om en chunk är sånt JSON eller riktig text förrän vi sett
    // starten av den — så vänta med att strömma tills vi vet, annars läcker
    // trasigt JSON ut i chatten innan vi hinner tolka om det till ett verktyg.
    let decided = false;
    let streamAsText = false;

    // <think>-taggar strippas FÖRE beslutet ovan — annars ser vi ett "<" och
    // gissar fel om chunken är prosa eller ett verktygsanrop.
    const think = createThinkStripper();

    await readNDJSON(res, (obj) => {
      const msg = obj.message;
      if (!msg) return;
      if (msg.tool_calls?.length) nativeToolCalls = msg.tool_calls;

      if (msg.content) {
        const visible = think.push(msg.content);
        if (!visible) return;
        text += visible;
        if (!decided && text.trim().length > 0) {
          decided = true;
          streamAsText = !looksLikeToolCallStart(text);
        }
        if (decided && streamAsText) onDelta?.(visible);
      }
    });

    const tail = think.flush();
    if (tail) {
      text += tail;
      if (decided && streamAsText) onDelta?.(tail);
    }

    const content: any[] = [];

    const fallbackCalls =
      nativeToolCalls.length === 0 && text ? parseFallbackToolCalls(text) : null;

    if (fallbackCalls) {
      for (const fc of fallbackCalls) {
        content.push({
          type: "tool_use",
          id: `call_${Math.random().toString(36).slice(2)}`,
          name: fc.name,
          input: fc.arguments,
        });
      }
      return { content };
    }

    if (text) content.push({ type: "text", text });

    for (const tc of nativeToolCalls) {
      let input: any = {};
      try {
        input =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
      } catch {
        content.push({
          type: "text",
          text: `[trasig tool-input: ${tc.function.arguments}]`,
        });
        continue;
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
        name: tc.function.name,
        input,
      });
    }

    return { content };
  }
}

function looksLikeToolCallStart(s: string): boolean {
  return /^\s*(```|<tool_call>|\{|\[)/.test(s);
}

// Läser NDJSON-strömmen från Ollamas /api/chat (en JSON-rad per chunk) och
// anropar onLine för varje avkodad rad.
async function readNDJSON(res: Response, onLine: (obj: any) => void) {
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
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // ignorera trasiga/ofullständiga rader
      }
    }
  }
}

// Tolkar ett verktygsanrop som modellen skrev som text i stället för att
// fylla i tool_calls: bart JSON-objekt/array, ett eller flera ```json-block,
// <tool_call>-taggar, eller flera JSON-objekt konkatenerade efter varandra.
function parseFallbackToolCalls(
  raw: string
): { name: string; arguments: any }[] | null {
  const text = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/<\/?tool_call>/g, "")
    .trim();
  if (!text) return null;

  const values = extractJsonValues(text);
  if (!values) return null;

  const asCall = (v: any): { name: string; arguments: any } | null =>
    v && typeof v === "object" && !Array.isArray(v) && typeof v.name === "string"
      ? { name: v.name, arguments: v.arguments ?? {} }
      : null;

  const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
  const calls = flat.map(asCall);
  return calls.every((c): c is NonNullable<typeof c> => c !== null)
    ? calls
    : null;
}

// Läser ut alla balanserade JSON-värden (objekt/arrayer) som står efter
// varandra i en text, separerade av valfritt whitespace. Ger null om något
// mellan värdena inte är whitespace — då är det troligen vanlig text/prosa.
function extractJsonValues(text: string): any[] | null {
  const results: any[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    if (text[i] !== "{" && text[i] !== "[") return null;

    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (; i < n; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    if (depth !== 0) return null;

    try {
      results.push(JSON.parse(text.slice(start, i)));
    } catch {
      return null;
    }
  }
  return results.length > 0 ? results : null;
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
          function: { name: b.name, arguments: b.input },
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
