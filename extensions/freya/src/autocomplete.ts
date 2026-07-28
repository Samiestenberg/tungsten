// Freya inline-autocomplete: liten LOKAL FIM-modell (1.5B, port 11435).
// Egen lane, medvetet skild från chatten. Komplettering ska vara gratis,
// snabb och fungera offline, så den går alltid mot en modell på maskinen --
// den inbäddade i första hand, användarens egen Ollama som reserv.
import * as vscode from "vscode";
import { reportAutocompleteOutage } from "./healthState.js";
import { localInfill } from "./localModel.js";
import { recordCompletionShown } from "./fim/nextEdit.js";

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

// Väntar ms millisekunder men ger upp direkt om VS Code avbryter.
// VS Code avbryter föregående inline-request när användaren skriver vidare,
// så det ÄR debouncen — ingen delad timer behövs (en sådan skulle dessutom
// lämna tidigare anrops promise ohanterad).
function debounce(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(true);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(false);
    });
  });
}

/**
 * Tak för inline-förslag från den inbäddade modellen. Se fimLocal.
 *
 * Talet kommer ur mätning, inte magkänsla: 1.5B:n genererar ~40 tokens/s på
 * CPU, så 24 tokens är ~600 ms generering plus prompt-eval. Högre tak gav
 * 1-2,8 s och förslag som fortsatte förbi det man ville ha.
 */
const INLINE_TOKEN_CAP = 24;

const FIM_STOP = [
  "<|fim_pad|>",
  "<|endoftext|>",
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|file_sep|>",
  "<|repo_name|>",
];

/**
 * FIM mot den INBÄDDADE modellen först. Den finns i det packade bygget och
 * behöver ingenting installerat, så den är standardvägen. Går den inte att nå
 * (dev-träd utan runtime, eller freya.local.enabled=false) faller vi tillbaka
 * på användarens egen Ollama nedan.
 */
async function fimLocal(
  prefix: string,
  suffix: string,
  signal: AbortSignal
): Promise<string | undefined> {
  // Latensen följer antalet genererade tokens, inte modellstorleken. Med
  // n_predict 256 och inget radstopp fortsatte 1.5B:n förbi kompletteringen och
  // hittade på fler metoder: uppmätt 2264 ms och ett förslag ingen ville ha.
  //
  // Ett tomrads-stopp ("\n\n") hjälpte inte — modellen skriver rad efter rad
  // utan tomrader, så den gick till taket ändå. EN rad är rätt enhet för
  // inline-förslag, så vi stoppar på "\n".
  //
  // Taket är ett tak, inte en ny default: den som höjer autocomplete.maxTokens
  // får fortfarande längre förslag på Ollama-vägen.
  const configured = cfg().get<number>("autocomplete.maxTokens") ?? 256;
  const out = await localInfill(prefix, suffix, {
    maxTokens: Math.min(configured, INLINE_TOKEN_CAP),
    temperature: 0.1,
    stop: [...FIM_STOP, "\n"],
    signal,
  });
  return out === undefined ? undefined : out.replace(/<\|[^|]*\|>/g, "");
}

async function fim(
  prefix: string,
  suffix: string,
  signal: AbortSignal
): Promise<string> {
  const url = cfg().get<string>("ollama.url") || "http://localhost:11434";
  const model =
    cfg().get<string>("autocomplete.model") || "qwen2.5-coder:1.5b-base";
  const numPredict = cfg().get<number>("autocomplete.maxTokens") ?? 256;

  const res = await fetch(`${url}/api/generate`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
      raw: true, // hoppa Ollamas chat-mall — FIM måste gå in rått
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: numPredict,
        stop: FIM_STOP,
      },
    }),
  });

  if (!res.ok) return "";
  const data: any = await res.json();
  return String(data.response ?? "").replace(/<\|[^|]*\|>/g, "");
}

export function registerAutocomplete(ctx: vscode.ExtensionContext): void {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _context, token) {
      if (!cfg().get<boolean>("autocomplete.enabled", true)) return;
      // Inga förslag i utdata-kanaler, differ, scm-input osv.
      if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
        return;
      }

      const debounceMs = cfg().get<number>("autocomplete.debounceMs") ?? 200;
      if (!(await debounce(debounceMs, token))) return;

      const maxPrefix = cfg().get<number>("autocomplete.prefixChars") ?? 3000;
      const maxSuffix = cfg().get<number>("autocomplete.suffixChars") ?? 1000;

      const text = document.getText();
      const offset = document.offsetAt(position);
      const prefix = text.slice(Math.max(0, offset - maxPrefix), offset);
      const suffix = text.slice(offset, offset + maxSuffix);

      // Koppla VS Codes cancellation till fetch-abort så att en övergiven
      // request inte fortsätter belasta Ollama.
      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());

      let completion = "";
      try {
        // Inbäddad modell först, Ollama som reserv.
        const local = await fimLocal(prefix, suffix, ac.signal);
        completion = local !== undefined ? local : await fim(prefix, suffix, ac.signal);
      } catch (err: any) {
        // Föreslå inget — men var inte tyst OM det inte var användaren som
        // avbröt. Ett nere Ollama såg tidigare exakt ut som "modellen hade
        // inget att föreslå", vilket är det som gjorde felet osynligt.
        if (!token.isCancellationRequested && err?.name !== "AbortError") {
          reportAutocompleteOutage();
        }
        return;
      } finally {
        sub.dispose();
      }

      if (!completion.trim() || token.isCancellationRequested) return;

      // Next-edit-förutsägelsen ska inte fyra på det användaren nyss
      // accepterade från autocomplete: det är inte en ändring användaren
      // gjorde, det är vårt eget förslag som kom tillbaka.
      recordCompletionShown(document.uri, completion);

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        ),
      ];
    },
  };

  ctx.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      provider
    )
  );
}
