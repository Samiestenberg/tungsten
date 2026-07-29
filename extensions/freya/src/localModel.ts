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
import { invalidateLocalEndpoint, localEndpoint } from "./localServer.js";
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
 * POSTar till den inbäddade servern, med ETT omförsök på KONTAKTFEL.
 *
 * VARFÖR OMFÖRSÖKET FINNS: ett andra fönster kan ha adopterat en llama-server
 * som ett första fönster äger, och när det första stängs rivs processen medan
 * det andra har adressen kvar i cachen. Se invalidateEndpoint() i
 * localServer.ts -- utan den här ventilen tystnar autocomplete i det andra
 * fönstret för resten av sessionen.
 *
 * Bara kontaktfel försöks om. Ett HTTP-svar -- även 500 -- betyder att servern
 * lever och sa nej, och det ska inte döljas av en retry. Användarens egen
 * avbrytning kastas vidare orörd.
 *
 * undefined = ingen inbäddad modell alls; anroparen får falla tillbaka.
 */
async function postToLocal(
  route: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response | undefined> {
  const attempt = async (): Promise<Response | undefined> => {
    const ep = await activeLocalEndpoint();
    if (!ep) return undefined;
    return fetch(`${ep.baseUrl}${route}`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  };

  try {
    return await attempt();
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      throw err;
    }
    invalidateLocalEndpoint();
    return attempt();
  }
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
  const res = await postToLocal(
    "/infill",
    {
      input_prefix: prefix,
      input_suffix: suffix,
      n_predict: opts.maxTokens ?? 256,
      temperature: opts.temperature ?? 0.1,
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
    },
    opts.signal
  );
  if (!res) return undefined;

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
  const res = await postToLocal(
    "/v1/completions",
    {
      prompt,
      max_tokens: opts.maxTokens ?? 96,
      temperature: opts.temperature ?? 0.1,
      ...(opts.stop?.length ? { stop: opts.stop } : {}),
    },
    opts.signal
  );
  if (!res) return undefined;

  if (!res.ok) {
    throw new Error(`local /v1/completions ${res.status}: ${await res.text()}`);
  }
  const data: any = await res.json();
  return String(data?.choices?.[0]?.text ?? "");
}
