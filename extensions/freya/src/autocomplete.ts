// Freya inline-autocomplete: den lilla LOKALA FIM-modellen (1.5B, port 11435).
//
// Egen lane, medvetet skild från chatten. Komplettering ska vara gratis,
// snabb och fungera offline, så den går alltid mot en modell på maskinen --
// den inbäddade i första hand, användarens egen Ollama som reserv.
//
// EN PROVIDER, FLERA BETEENDEN. Vad markören står i avgör tokenbudget och
// stopp, inte vilken kodväg som körs:
//
//   rad     nästa uttryck på raden              24 tokens, stopp "\n"
//   block   resten av kroppen efter { eller :   96 tokens, flera rader
//
// Klassificeringen ligger i fim/fimTrigger.ts som en ren funktion. Skälet är
// att en provider per beteende hade betytt flera anrop per tangenttryck och
// flera förslag som slåss om samma yta.
import * as vscode from "vscode";
import { reportAutocompleteOutage } from "./healthState.js";
import {
  cleanFimOutput,
  debounce,
  FIM_STOP,
  fimContext,
  isEditableDocument,
  runFim,
} from "./fim/fimCore.js";
import { classifyFimTrigger, trimToBlock } from "./fim/fimTrigger.js";
import { recordCompletionShown } from "./fim/nextEdit.js";

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

/**
 * FIM mot användarens egen Ollama. Reserv för dev-träd utan inbäddad runtime
 * och för den som satt freya.light.backend till ollama.
 */
async function fimViaOllama(
  prefix: string,
  suffix: string,
  maxTokens: number,
  stop: string[],
  signal: AbortSignal
): Promise<string> {
  const url = cfg().get<string>("ollama.url") || "http://localhost:11434";
  const model =
    cfg().get<string>("autocomplete.model") || "qwen2.5-coder:1.5b-base";

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
        num_predict: maxTokens,
        stop: [...FIM_STOP, ...stop],
      },
    }),
  });

  if (!res.ok) return "";
  const data: any = await res.json();
  return cleanFimOutput(String(data.response ?? ""));
}

export function registerAutocomplete(ctx: vscode.ExtensionContext): void {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, _context, token) {
      if (!cfg().get<boolean>("autocomplete.enabled", true)) return;
      // Inga förslag i utdata-kanaler, differ, scm-input osv.
      if (!isEditableDocument(document)) return;

      const debounceMs = cfg().get<number>("autocomplete.debounceMs") ?? 200;
      if (!(await debounce(debounceMs, token))) return;

      const offset = document.offsetAt(position);
      const { prefix, suffix } = fimContext(document, offset);

      const configured = cfg().get<number>("autocomplete.maxTokens") ?? 256;
      const plan = classifyFimTrigger(prefix, document.languageId, configured);

      // Koppla VS Codes cancellation till fetch-abort så att en övergiven
      // request inte fortsätter belasta modellen.
      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());

      let completion = "";
      try {
        // Inbäddad modell först, Ollama som reserv.
        const local = await runFim({
          prefix,
          suffix,
          maxTokens: plan.maxTokens,
          stop: plan.stop,
          signal: ac.signal,
        });
        completion =
          local !== undefined
            ? local
            : await fimViaOllama(prefix, suffix, plan.maxTokens, plan.stop, ac.signal);
      } catch (err: any) {
        // Föreslå inget — men var inte tyst OM det inte var användaren som
        // avbröt. En nere modell såg tidigare exakt ut som "modellen hade
        // inget att föreslå", vilket är det som gjorde felet osynligt.
        if (!token.isCancellationRequested && err?.name !== "AbortError") {
          reportAutocompleteOutage();
        }
        return;
      } finally {
        sub.dispose();
      }

      if (plan.multiline) {
        // Ett blockförslag får inte fortsätta förbi den stängande klammern och
        // skriva nästa funktion också. Se trimToBlock.
        completion = trimToBlock(completion, plan.baseIndent);
      } else {
        // Enradsplanerna har "\n" som stopp, men Ollama-reserven respekterar
        // inte alltid stoppet exakt. Ett flerradigt svar där EN rad var utlovad
        // är värre än ett kortare svar.
        const nl = completion.indexOf("\n");
        if (nl >= 0) {
          completion = completion.slice(0, nl);
        }
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
