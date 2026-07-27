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
  // qwen2.5-coder skriver gärna anropet som ```json i svarstexten trots att
  // Ollamas egen tools-mall säger emot. Ollama tolkar DÄREMOT <tool_call>-
  // taggen och gör då ett riktigt tool_calls-svar, så vi pekar dit explicit.
  // Parsern i den här filen räddar de fall där modellen ändå inte lyssnar.
  "VERKTYG:",
  "Anropa verktyg via tool-API:t, inte som text i svaret.",
  "Måste du ändå skriva anropet i texten: använd EXAKT",
  '<tool_call>{"name": "verktygsnamn", "arguments": {...}}</tool_call>',
  "och skriv inget annat i samma svar.",
  "Skriv ALDRIG verktygsanrop i ```json-block och blanda aldrig ett anrop",
  "med förklarande text — förklara efteråt, när du fått resultatet.",
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

    // Bara verktyg som FAKTISKT är registrerade får återskapas ur text. Utan
    // den kontrollen blir vanlig JSON i ett kodsvar tolkat som ett anrop.
    // Tom verktygslista (t.ex. languageModel.ts) stänger av återskapningen
    // helt, vilket är rätt: där finns ingen loop som kan köra ett verktyg.
    const knownTools = new Set<string>(
      tools.map((t) => t?.name).filter((n): n is string => typeof n === "string")
    );

    // Allt fram till första tecknet som KAN inleda ett verktygsanrop strömmas
    // direkt. Resten hålls tillbaka tills vi vet om det blev ett anrop eller
    // bara prosa — annars läcker ```json-blocket ut i chatten innan vi hunnit
    // tolka om det till ett verktyg (det var precis felet).
    const CALL_START = /```|<tool_call>|\{/;
    let emitted = 0;
    const streamSafePrefix = () => {
      const m = CALL_START.exec(text.slice(emitted));
      const safeEnd = m ? emitted + m.index : text.length;
      if (safeEnd > emitted) {
        onDelta?.(text.slice(emitted, safeEnd));
        emitted = safeEnd;
      }
    };

    // <think>-taggar strippas FÖRE gaten ovan — annars ser vi ett "<" och
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
        streamSafePrefix();
      }
    });

    const tail = think.flush();
    if (tail) {
      text += tail;
      streamSafePrefix();
    }

    const content: any[] = [];

    const fallbackCalls =
      nativeToolCalls.length === 0 && text
        ? parseFallbackToolCalls(text, knownTools)
        : null;

    // Inget anrop hittat: det tillbakahållna var vanlig text trots allt.
    if (!fallbackCalls && emitted < text.length) {
      onDelta?.(text.slice(emitted));
      emitted = text.length;
    }

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

// Nycklar modellen använder för argumenten. "parameters" är samma alias-fälla
// som i verktygsschemat: modellen härmar schemat i stället för anropsformatet.
const ARG_KEYS = ["arguments", "parameters", "args"];

/** Argumenten normaliserade till ett objekt, eller undefined om de är skräp. */
function coerceArgs(value: any): Record<string, any> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/**
 * Är det här objektet ett verktygsanrop för ett REGISTRERAT verktyg?
 * Accepterar både {"name","arguments"} och OpenAI-formen
 * {"function":{"name","arguments"}}.
 */
function asToolCall(
  value: any,
  knownTools: ReadonlySet<string>
): { name: string; arguments: any } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const src =
    value.function && typeof value.function === "object" && !Array.isArray(value.function)
      ? value.function
      : value;

  if (typeof src.name !== "string" || !knownTools.has(src.name)) return null;

  const key = ARG_KEYS.find((k) => src[k] !== undefined);
  if (key === undefined) return { name: src.name, arguments: {} };

  const args = coerceArgs(src[key]);
  // Namnet stämmer men argumenten går inte att tolka: hellre ingen träff än
  // att köra ett verktyg med gissade argument.
  return args === undefined ? null : { name: src.name, arguments: args };
}

/**
 * Slutindex (exklusivt) för det balanserade {...} som börjar på `start`, eller
 * -1 om det inte går ihop. Sträng- och escape-medveten så att en klammer inne
 * i en JSON-sträng inte räknas.
 */
function matchBalancedObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
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
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Letar verktygsanrop var som helst i texten: bart JSON, i ```json-block, i
 * <tool_call>-taggar, inbäddat i prosa (före ELLER efter), och flera i rad.
 *
 * Varför "var som helst" och inte bara hela svaret: qwen2.5-coder skriver
 * regelbundet anropet i ett ```json-block och lägger en förklaring runt det.
 * Den gamla parsern krävde att ingenting utom whitespace stod mellan
 * JSON-värdena, så precis de svaren föll igenom och läckte ut som text medan
 * verktyget aldrig kördes.
 */
function findEmbeddedToolCalls(
  text: string,
  knownTools: ReadonlySet<string>
): { name: string; arguments: any }[] {
  const found: { name: string; arguments: any }[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    const end = matchBalancedObject(text, i);
    if (end < 0) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(text.slice(i, end));
    } catch {
      continue; // inte JSON — leta vidare från nästa tecken
    }

    const call = asToolCall(parsed, knownTools);
    if (call) {
      found.push(call);
    } else {
      // Ett steg ner: {"tool_call": {...}} och liknande omslag. Djupare än så
      // letar vi inte — då börjar vi hitta anrop i data som bara ser ut som ett.
      for (const nested of Object.values(parsed ?? {})) {
        const nestedCall = asToolCall(nested, knownTools);
        if (nestedCall) found.push(nestedCall);
      }
    }

    i = end - 1; // fortsätt efter objektet
  }

  return found;
}

/**
 * Verktygsanrop som modellen skrev som text i stället för att fylla tool_calls.
 * null när inget giltigt anrop finns — då är texten vanlig text.
 *
 * Exporterad för test: ren funktion, inga beroenden på vscode eller nätverk.
 */
export function parseFallbackToolCalls(
  raw: string,
  knownTools: ReadonlySet<string>
): { name: string; arguments: any }[] | null {
  if (!raw || knownTools.size === 0) return null;
  const calls = findEmbeddedToolCalls(raw, knownTools);
  return calls.length > 0 ? calls : null;
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
