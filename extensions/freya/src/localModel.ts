// Klient mot den inbäddade 1.5B-servern. Den LÄTTA lanen går hit.
//
// Modellen är en BASE-modell (Qwen2.5-Coder-1.5B base), inte en instruct-modell.
// Den har ingen chat-mall, så vi använder aldrig /v1/chat/completions här --
// bara rå komplettering (/v1/completions) med few-shot-prompter, och /infill
// för fill-in-the-middle. Mätt på den faktiska modellen:
//   FIM              ~390 ms varm
//   commit-rubrik    ~1080 ms   ("lagg till probeOllama-funktion")
//   kodförklaring    ~810 ms    ("Returnerar summan av alla tal i listan.")
// Det räcker för allt som ska kännas gratis och köra ofta.
import { localEndpoint } from "./localServer.js";
import { lightBackend } from "./config.js";

/**
 * Endpointen till den inbäddade modellen, eller undefined när den lätta lanen
 * är satt till Ollama. Ett enda ställe att gå igenom, så routningsvalet gäller
 * autocomplete, commit-rubriker och förklaringar samtidigt.
 */
async function activeLocalEndpoint() {
  return lightBackend() === "ollama" ? undefined : localEndpoint();
}

export interface CompleteOptions {
  /** Stoppsekvenser. En base-modell slutar inte av sig själv. */
  stop?: string[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** true om den inbäddade modellen är uppe och kan ta emot anrop. */
export async function localAvailable(): Promise<boolean> {
  return (await activeLocalEndpoint()) !== undefined;
}

/**
 * Fill-in-the-middle via llama.cpp:s /infill. Servern använder modellens egna
 * FIM-tokens ur GGUF-metadatan, så vi behöver inte bygga prompten själva
 * (till skillnad från Ollama-vägen, som kräver raw:true och <|fim_*|> för hand).
 * undefined = ingen inbäddad modell; anroparen får falla tillbaka.
 */
export async function localInfill(
  prefix: string,
  suffix: string,
  opts: CompleteOptions = {}
): Promise<string | undefined> {
  const ep = await activeLocalEndpoint();
  if (!ep) return undefined;

  const res = await fetch(`${ep.baseUrl}/infill`, {
    method: "POST",
    signal: opts.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify({
      input_prefix: prefix,
      input_suffix: suffix,
      n_predict: opts.maxTokens ?? 256,
      temperature: opts.temperature ?? 0.1,
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`local /infill ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  return String(data?.content ?? "");
}

/**
 * Rå textkomplettering. Prompten ska vara few-shot-formad — en base-modell
 * följer inte instruktioner, den fortsätter mönstret den ser.
 * undefined = ingen inbäddad modell.
 */
export async function localComplete(
  prompt: string,
  opts: CompleteOptions = {}
): Promise<string | undefined> {
  const ep = await activeLocalEndpoint();
  if (!ep) return undefined;

  const res = await fetch(`${ep.baseUrl}/v1/completions`, {
    method: "POST",
    signal: opts.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify({
      prompt,
      max_tokens: opts.maxTokens ?? 96,
      temperature: opts.temperature ?? 0.1,
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`local /v1/completions ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  return String(data?.choices?.[0]?.text ?? "");
}
