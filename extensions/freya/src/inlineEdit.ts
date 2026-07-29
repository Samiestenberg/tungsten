// FAS C2: inline edit. FLAGGSKEPPET i instruct-lanen.
//
// Markera kod -> skriv en instruktion -> 3B skriver om ENDAST markeringen ->
// se diffen -> godkänn. Ett skott, ingen loop, inga verktyg.
//
// VARFÖR INGEN LOOP: en agent-loop hade behövt tolka modellens svar som
// handlingar, och det är precis den felklassen som gjorde 14B-lanen opålitlig
// (prosa-JSON, halva verktygsanrop, ändringar som aldrig blev av). Här är
// kontraktet i stället maximalt smalt: in går ett fragment och en mening, ut
// kommer ett fragment. Det finns ingenting att feltolka.
//
// TRE SAKER SOM KODEN GÖR, INTE MODELLEN:
//
//   1. Fences bort. 3B lägger koden i ```typescript även när instruktionen
//      säger nej -- uppmätt, inte befarat. Ett staket i källfilen är trasig
//      kod, så vi ber modellen låta bli OCH städar efteråt.
//   2. Indenteringen tillbaka. Modellen svarar på kolumn noll även när
//      fragmentet var två nivåer in. Att skriva in det rakt av hade
//      platt-tryckt filen.
//   3. Diffen först. Ingenting ersätts förrän användaren sett vad som byts ut
//      och sagt ja.
import * as vscode from "vscode";
import {
  clampToLines,
  instructAvailable,
  instructCode,
  INSTRUCT_MISSING,
  reindent,
} from "./instructModel.js";

/** Taket för hur stort fragment som skickas. 3B har 8192 tokens totalt. */
const MAX_FRAGMENT_CHARS = 6000;

/**
 * Prompten är STRAM med flit. Varje extra regel är en regel 3B kan följa
 * halvvägs; de fem nedan är de som faktiskt behövdes för att svaret skulle gå
 * att klistra in.
 */
const SYSTEM = [
  "You rewrite a selected fragment of code.",
  "Output ONLY the rewritten fragment. No explanation, no markdown fences, no commentary.",
  "Keep the surrounding style: same language, same indentation, same quoting.",
  "Change only what the instruction asks for. Preserve everything else exactly.",
  "If the instruction cannot be applied, output the fragment unchanged.",
].join("\n");

function userPrompt(
  fragment: string,
  instruction: string,
  languageId: string
): string {
  return [
    `Language: ${languageId}`,
    `Instruction: ${instruction}`,
    "",
    "Fragment:",
    clampToLines(fragment, MAX_FRAGMENT_CHARS),
  ].join("\n");
}

/**
 * Förhandsvisningen är en riktig diff-editor och inte en modal med text i.
 *
 * Skälet är praktiskt: en modal `detail`-sträng radbryts inte som kod, går
 * inte att bläddra i och saknar syntaxfärgning. En omskriven funktion på
 * trettio rader är oläslig där. Diff-editorn är ytan användaren redan läser
 * ändringar i.
 */
const PREVIEW_SCHEME = "freya-inline-edit";

/** Innehållet bakom preview-URI:erna. Rensas när diffen stängts. */
const previewContent = new Map<string, string>();

class PreviewProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return previewContent.get(uri.toString()) ?? "";
  }
}

let previewCounter = 0;

/**
 * Öppnar diffen och frågar. Returnerar true om användaren godkände.
 *
 * Diffen stängs alltid innan vi återvänder -- annars blir det en flik kvar
 * som visar en ändring som antingen redan är gjord eller aldrig blev av.
 */
async function confirmViaDiff(
  before: string,
  after: string,
  languageId: string,
  title: string
): Promise<boolean> {
  const id = ++previewCounter;
  // Filändelsen i sökvägen är det som ger diffen syntaxfärgning.
  const suffix = languageId ? `.${languageId}` : "";
  const left = vscode.Uri.parse(`${PREVIEW_SCHEME}:/current-${id}${suffix}`);
  const right = vscode.Uri.parse(`${PREVIEW_SCHEME}:/freya-${id}${suffix}`);
  previewContent.set(left.toString(), before);
  previewContent.set(right.toString(), after);

  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      title,
      { preview: true }
    );

    const answer = await vscode.window.showInformationMessage(
      "Freya rewrote the selection.",
      { modal: false },
      "Apply",
      "Discard"
    );
    return answer === "Apply";
  } finally {
    previewContent.delete(left.toString());
    previewContent.delete(right.toString());
    // Stäng diff-fliken. activeTextEditor är inte satt för en diff, så vi går
    // via kommandot i stället för att leta upp den.
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
}

export function registerInlineEdit(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      new PreviewProvider()
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.inlineEdit", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Freya: no open file.");
        return;
      }

      // Utan markering: raden markören står på. Att kräva en markering för
      // "skriv om det här" är onödigt krångel när det oftast är en rad.
      const range = editor.selection.isEmpty
        ? editor.document.lineAt(editor.selection.active.line).range
        : new vscode.Range(editor.selection.start, editor.selection.end);

      const fragment = editor.document.getText(range);
      if (!fragment.trim()) {
        vscode.window.showInformationMessage(
          "Freya: select the code you want to change."
        );
        return;
      }

      if (!instructAvailable()) {
        vscode.window.showWarningMessage(`Freya: ${INSTRUCT_MISSING}`);
        return;
      }

      const instruction = await vscode.window.showInputBox({
        title: "Freya: rewrite the selection",
        prompt: "What should change? Runs locally on the 3B model.",
        placeHolder: "e.g. add error handling, convert to async/await, add types",
        ignoreFocusOut: true,
      });
      if (!instruction?.trim()) {
        return;
      }

      const proposal = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Freya is rewriting the selection...",
          cancellable: true,
        },
        async (_progress, token) => {
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            return await instructCode({
              system: SYSTEM,
              user: userPrompt(fragment, instruction.trim(), editor.document.languageId),
              // Svaret ska rymma fragmentet igen plus lite. Fyra tecken per
              // token är den grova tumregeln vi använder på andra ställen.
              maxTokens: Math.min(1200, Math.ceil(fragment.length / 3) + 256),
              signal: ac.signal,
            });
          } catch {
            return undefined;
          } finally {
            sub.dispose();
          }
        }
      );

      if (!proposal?.trim()) {
        vscode.window.showWarningMessage(
          "Freya: the model returned nothing. Try a shorter selection or a more specific instruction."
        );
        return;
      }

      // Indenteringen tillbaka. Se filhuvudet, punkt 2.
      const anchorLine = editor.document.lineAt(range.start.line).text;
      const anchorIndent = /^[ \t]*/.exec(anchorLine)![0];
      const rewritten = reindent(
        proposal,
        anchorIndent,
        range.start.character === 0
      );

      if (rewritten.trim() === fragment.trim()) {
        vscode.window.showInformationMessage(
          "Freya: the model left the selection unchanged."
        );
        return;
      }

      const approved = await confirmViaDiff(
        fragment,
        rewritten,
        editor.document.languageId,
        `Freya: ${instruction.trim()}`
      );
      if (!approved) {
        return;
      }

      // Dokumentet kan ha ändrats medan diffen låg uppe. Att skriva över ändå
      // vore att kasta bort användarens arbete.
      if (editor.document.getText(range) !== fragment) {
        vscode.window.showWarningMessage(
          "Freya: the selection changed while the diff was open. Nothing was applied."
        );
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.replace(editor.document.uri, range, rewritten);
      await vscode.workspace.applyEdit(edit);
    })
  );
}
