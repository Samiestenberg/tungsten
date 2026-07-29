// FAS C5, del 2: föreslå namn.
//
// "Vad ska jag kalla den här?" är en av få frågor där en liten modell är
// genuint bra: den kräver ingen kedja av resonemang, bara att man läser vad
// koden gör och sätter ord på det. Och det är en fråga där man ofta fastnar
// längre än man vill erkänna.
//
// PÅ BEGÄRAN, aldrig av sig självt. Ett namnförslag som dyker upp oombett över
// varje variabel är en tillsägelse, inte ett hjälpmedel.
//
// OMDÖPNINGEN GÅR VIA SPRÅKSERVERN när det går. Det är skillnaden mellan att
// byta namn och att byta ut en textsträng: språkservern hittar alla
// användningar, inklusive dem i andra filer. Först när ingen rename-provider
// finns faller vi tillbaka på att ersätta markeringen -- och säger det.
import * as vscode from "vscode";
import {
  clampToLines,
  instructAvailable,
  instructOneShot,
  INSTRUCT_MISSING,
  isIdentifier,
  parseList,
} from "./instructModel.js";

/** Hur mycket kod runt omkring som skickas med. Namnet följer av användningen. */
const CONTEXT_CHARS = 1500;

const SYSTEM = [
  "You suggest names for things in code.",
  "Reply with five candidate names, one per line, nothing else.",
  "No numbering, no quotes, no explanation, no backticks.",
  "Follow the naming conventions of the language you are shown.",
  "Say what the thing IS or DOES. Never use generic names like data, value, item, temp, result.",
].join("\n");

function userPrompt(
  name: string,
  context: string,
  languageId: string,
  kind: string
): string {
  return [
    `Language: ${languageId}`,
    `Rename this ${kind}: ${name}`,
    "",
    "How it is used:",
    clampToLines(context, CONTEXT_CHARS),
    "",
    `Suggest five better names for ${name}.`,
  ].join("\n");
}

/**
 * Vad markeringen är, i grova drag. Går bara till prompten som ett ord, så
 * gissningen behöver inte vara exakt -- den ska bara styra modellen mot rätt
 * namngivningskonvention (verb för funktioner, substantiv för värden).
 */
function guessKind(document: vscode.TextDocument, range: vscode.Range): string {
  const line = document.lineAt(range.start.line).text;
  if (/\b(function|def|fn|func)\b/.test(line) || /\(\s*\)?\s*(=>|\{)/.test(line)) {
    return "function";
  }
  if (/\b(class|interface|struct|type|enum)\b/.test(line)) {
    return "type";
  }
  return "variable";
}

/** Byter namn via språkservern om det går, annars via markeringen. */
async function applyRename(
  document: vscode.TextDocument,
  range: vscode.Range,
  newName: string
): Promise<void> {
  try {
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      document.uri,
      range.start,
      newName
    );
    // En rename-provider som svarar med noll filer har inte gjort något; då är
    // fallbacken bättre än att låtsas att det gick.
    if (edit && edit.size > 0) {
      await vscode.workspace.applyEdit(edit);
      return;
    }
  } catch {
    // Inget språkstöd för rename i den här filtypen. Helt normalt.
  }

  const fallback = new vscode.WorkspaceEdit();
  fallback.replace(document.uri, range, newName);
  await vscode.workspace.applyEdit(fallback);
  vscode.window.showInformationMessage(
    "Freya: renamed here only -- this file type has no rename support, so other usages were not touched."
  );
}

export function registerNameThings(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.nameThings", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Freya: no open file.");
        return;
      }

      const range = editor.selection.isEmpty
        ? editor.document.getWordRangeAtPosition(editor.selection.active)
        : new vscode.Range(editor.selection.start, editor.selection.end);

      const current = range ? editor.document.getText(range).trim() : "";
      if (!range || !current) {
        vscode.window.showInformationMessage(
          "Freya: put the cursor on the name you want to change."
        );
        return;
      }

      if (!instructAvailable()) {
        vscode.window.showWarningMessage(`Freya: ${INSTRUCT_MISSING}`);
        return;
      }

      const text = editor.document.getText();
      const at = editor.document.offsetAt(range.start);
      const context = text.slice(
        Math.max(0, at - CONTEXT_CHARS / 2),
        at + CONTEXT_CHARS / 2
      );

      const raw = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Freya is thinking of names...",
          cancellable: true,
        },
        async (_progress, token) => {
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            return await instructOneShot({
              system: SYSTEM,
              user: userPrompt(
                current,
                context,
                editor.document.languageId,
                guessKind(editor.document, range)
              ),
              maxTokens: 120,
              signal: ac.signal,
            });
          } catch {
            return undefined;
          } finally {
            sub.dispose();
          }
        }
      );

      // Bara giltiga identifierare, och aldrig namnet som redan står där.
      const names = parseList(raw ?? "", 6, isIdentifier).filter(
        (n) => n !== current
      );

      if (names.length === 0) {
        vscode.window.showInformationMessage(
          "Freya: no name suggestions this time."
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(names, {
        title: `Freya: rename ${current}`,
        placeHolder: "Pick a name, or press Esc to keep the current one",
      });
      if (!picked) {
        return;
      }

      await applyRename(editor.document, range, picked);
    })
  );
}
