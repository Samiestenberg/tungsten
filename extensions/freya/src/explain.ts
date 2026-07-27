// "Freya: Förklara markerad kod" — lätt uppgift, alltså inbäddad 1.5B.
//
// Ingen agent-loop, inga verktyg, inget moln: markera kod, få en mening eller
// två tillbaka. Kör den inbäddade modellen om den finns, annars Ollama, och
// säger ifrån tydligt om ingen av dem finns i stället för att göra ingenting.
import * as vscode from "vscode";
import { localComplete } from "./localModel.js";
import { autocompleteModel, ollamaUrl } from "./config.js";

/** Håll prompten liten — 1.5B har 4096 tokens kontext och ska svara snabbt. */
const MAX_CODE_CHARS = 4000;

/**
 * Few-shot i completion-form. Base-modellen följer inte instruktioner, den
 * fortsätter mönstret, så exemplet sätter både språk och längd.
 */
function explainPrompt(code: string, languageId: string): string {
  return [
    "# Briefly explain what the code does, in English.",
    "",
    "## Code (javascript)",
    "const dubbla = xs => xs.map(x => x * 2);",
    "## Explanation",
    "Returns a new list where every number has been doubled.",
    "",
    `## Code (${languageId})`,
    code.slice(0, MAX_CODE_CHARS),
    "## Explanation",
    "",
  ].join("\n");
}

/** Ollama-reserv. Samma few-shot, via /api/generate med raw:false. */
async function explainViaOllama(
  prompt: string,
  signal: AbortSignal
): Promise<string | undefined> {
  const url = ollamaUrl();
  // Autocomplete-modellen är den lilla lokala som redan är hämtad om användaren
  // kört Freya mot Ollama tidigare — samma storleksklass som den inbäddade.
  const model = autocompleteModel();
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        raw: true,
        stream: false,
        options: { temperature: 0.2, num_predict: 120, stop: ["\n\n", "## "] },
      }),
    });
    if (!res.ok) return undefined;
    const data: any = await res.json();
    return String(data?.response ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function registerExplain(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Freya: no open file.");
        return;
      }

      const sel = editor.selection;
      // Utan markering: förklara raden markören står på. Att kräva en markering
      // för ett "förklara"-kommando är onödigt krångel.
      const range = sel.isEmpty ? editor.document.lineAt(sel.active.line).range : sel;
      const code = editor.document.getText(range).trim();
      if (!code) {
        vscode.window.showInformationMessage(
          "Freya: select some code (or put the cursor on a line of code)."
        );
        return;
      }

      const prompt = explainPrompt(code, editor.document.languageId);

      const explanation = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Freya is explaining...",
        },
        async () => {
          const ac = new AbortController();
          const local = await localComplete(prompt, {
            stop: ["\n\n", "## "],
            maxTokens: 120,
            temperature: 0.2,
            signal: ac.signal,
          }).catch(() => undefined);

          const text = local?.trim();
          if (text) return text;
          return explainViaOllama(prompt, ac.signal);
        }
      );

      if (!explanation) {
        vscode.window.showWarningMessage(
          "Freya: no model could answer. The embedded model is missing and Ollama is not responding."
        );
        return;
      }

      // Informationsmeddelande och inte ett nytt dokument: en förklaring på en
      // eller två meningar ska inte kräva att man stänger en flik efteråt.
      vscode.window.showInformationMessage(explanation, { modal: false });
    })
  );
}
