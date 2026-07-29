// DEN DELADE INSTRUCT-RUNNERN. Allt i 3B-lanen går genom den här filen.
//
// ETT SKOTT, INGEN LOOP. Det är hela konstruktionen, inte en detalj:
//
//   * Ingen agent-loop. En funktion = ett anrop = ett svar. Kontrollflödet
//     ligger i VS Code-API:t (vår kod), och modellen fyller bara ett slott.
//   * INGEN tool-calling. Vi skickar aldrig ett `tools`-fält och vi letar
//     aldrig efter verktygsanrop i svaret. Hela felklassen som plågade
//     14B-lanen -- prosa-JSON, halva ```json-block, verktyg som aldrig kördes
//     medan JSON:en läckte ut i chatten -- kan inte uppstå här, för det finns
//     ingen kod som skulle kunna tolka ett verktygsanrop. Se
//     instructModel.test.ts, som håller den egenskapen på plats.
//   * Deterministiskt. temperature 0 och fast seed som default: samma
//     markering och samma instruktion ska ge samma diff två gånger i rad,
//     annars går det inte att lita på förhandsvisningen man just godkände.
//
// Modellen är en INSTRUCT-modell (till skillnad från FIM-lanens base-modell),
// så vi använder /v1/chat/completions och modellens egen chat-mall -- inte
// few-shot-prompter i /v1/completions.
import {
  beginInstructCall,
  endInstructCall,
  instructEndpoint,
  instructInstalled,
} from "./instructServer.js";
import { stripCodeFences } from "./instructText.js";

// De rena textfunktionerna bor i instructText.ts (ingen vscode-import, går att
// testa utan extension host). Vi re-exporterar dem så att anropare bara behöver
// känna till ETT ställe för instruct-lanen.
export {
  cacheKey,
  clampToLines,
  commonIndent,
  isIdentifier,
  parseList,
  reindent,
  stripCodeFences,
} from "./instructText.js";

export interface InstructTurn {
  role: "user" | "assistant";
  content: string;
}

export interface InstructOptions {
  /** Systeminstruktionen. Håll den stram -- 3B tappar långa regelverk. */
  system: string;
  /** Användarens tur. Kod och instruktion, inget mer. */
  user: string;
  /**
   * Tidigare turer, för chatt-lanen. Bryter INTE ett-skotts-regeln: en
   * chattur är fortfarande EN request som ger EN text tillbaka. Regeln
   * förbjuder loopen och verktygen, inte att modellen får se vad som sagts.
   */
  history?: readonly InstructTurn[];
  maxTokens?: number;
  /** Default 0. Höj bara där variation faktiskt är önskad. */
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
  /** Sätts bara av chatt-lanen. Utan den är anropet icke-strömmande. */
  onDelta?: (chunk: string) => void;
}

/** Tak som gäller när anroparen inte sagt något annat. */
const DEFAULT_MAX_TOKENS = 512;

/**
 * Fast seed. llama.cpp seedar slumpmässigt annars, och även med temperature 0
 * kan tie-breaks mellan likvärdiga tokens gå olika håll mellan körningar.
 */
const SEED = 7;

/** Kör 3B:n utan att starta den: finns modellen ens installerad? */
export function instructAvailable(): boolean {
  return instructInstalled();
}

/**
 * Finns modellen, eller kan den skaffas nu?
 *
 * Det här är vad ANVÄNDARVÄNDA ytor ska anropa i stället för
 * instructAvailable(). Skillnaden gäller den lilla installern: där finns 3B:n
 * inte på disk vid första körningen, och rätt svar är inte "funktionen är
 * otillgänglig" utan en fråga om att hämta den. instructAvailable() finns kvar
 * för de ställen som bara vill VETA utan att kunna visa UI -- CodeAction- och
 * hover-providrar, som körs oavbrutet och aldrig får öppna en dialog.
 *
 * Importen är dynamisk för att bryta en cirkel: modelDownload.ts behöver
 * runtimeLayout, som instructServer redan drar in, och en statisk import hade
 * gjort instructModel beroende av vscode-UI:t som den annars inte rör.
 */
export async function ensureInstructReady(): Promise<boolean> {
  if (instructInstalled()) {
    return true;
  }
  const { offerDownload, INSTRUCT_DOWNLOAD } = await import("./modelDownload.js");
  return offerDownload(INSTRUCT_DOWNLOAD);
}

/**
 * Ett skott mot instruct-modellen. Returnerar råtexten.
 * undefined = ingen 3B installerad; anroparen får säga det till användaren
 * i stället för att tyst göra ingenting.
 */
export async function instructOneShot(
  opts: InstructOptions
): Promise<string | undefined> {
  const ep = await instructEndpoint();
  if (!ep) return undefined;

  beginInstructCall();
  try {
    const body = {
      messages: [
        { role: "system", content: opts.system },
        ...(opts.history ?? []),
        { role: "user", content: opts.user },
      ],
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? 0,
      top_p: 1,
      seed: SEED,
      stream: !!opts.onDelta,
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
      // MEDVETET INGET `tools`-fält. Se filhuvudet. Att lägga till ett vore
      // att återinföra hela felklassen lanen finns för att undvika.
    };

    const res = await fetch(`${ep.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(
        `instruct /v1/chat/completions ${res.status}: ${await res.text()}`
      );
    }

    if (opts.onDelta) {
      return await readSSE(res, opts.onDelta);
    }

    const data: any = await res.json();
    // Bara .content. Ett eventuellt tool_calls-fält läses inte ens -- det
    // finns inget vi skulle göra med det.
    return String(data?.choices?.[0]?.message?.content ?? "");
  } finally {
    endInstructCall();
  }
}

/**
 * Läser OpenAI-stilens SSE-ström och matar onDelta löpande. Returnerar hela
 * texten när strömmen är slut, så anroparen kan efterbehandla den (t.ex.
 * strippa fences) utan att spara undan chunkarna själv.
 */
async function readSSE(
  res: Response,
  onDelta: (chunk: string) => void
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const chunk = obj?.choices?.[0]?.delta?.content;
        if (typeof chunk === "string" && chunk) {
          full += chunk;
          onDelta(chunk);
        }
      } catch {
        // Ofullständig rad — nästa varv får med resten.
      }
    }
  }

  return full;
}

/**
 * Ett skott som ska ge KOD tillbaka. Samma runner, plus fence-strippningen.
 * Alla ytor som ersätter kod (inline edit, semantisk fix, presets, tester) går
 * genom den här så att städningen sker på ETT ställe.
 */
export async function instructCode(
  opts: InstructOptions
): Promise<string | undefined> {
  const raw = await instructOneShot(opts);
  return raw === undefined ? undefined : stripCodeFences(raw);
}

/** Beskedet när 3B:n saknas. Ett ställe, samma ordval överallt. */
export const INSTRUCT_MISSING =
  "Tungsten's 3B instruct model is not installed in this build. " +
  "It ships with the packaged app; in a dev tree, run " +
  "`node --experimental-strip-types build/freya/fetchLocalRuntime.ts`.";
