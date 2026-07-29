// FAS C3: semantisk fix. Tvåstegsfelsökningen, STEG 2.
//
// Steg 1 (fim/syntaxFix.ts) tar det parsern redan vet: saknad klammer, saknat
// komma. Det går till 1.5B som FIM, i realtid, på ~200 ms.
//
// HÄR tas resten: "Property 'x' does not exist on type 'Y'", en runtime-krasch,
// ett fel som kräver att någon förstår typerna och vad ändringen försökte
// göra. Gränsen dras i fim/syntaxSignal.ts och är densamma åt båda håll --
// den här filen frågar samma funktion och tar det den säger NEJ till.
//
// TVÅ REGLER SOM INTE FÅR GLIDA:
//
//   1. ON-DEMAND, ALDRIG AUTO-POPUP. Åtgärden dyker upp i glödlampan när
//      användaren klickar på felet. Den kör INGEN modell förrän den valts:
//      CodeAction:en bär ett `command`, inte en `edit`. En 3B-körning per
//      diagnostikuppdatering hade varit en modellkörning per tangenttryck.
//
//   2. DIFF ATT GODKÄNNA, ALDRIG AUTO-APPLY. Går genom preview.confirmViaDiff
//      som alla andra kodändrande ytor.
//
// KONTEXTEN vi skickar är vald efter vad som faktiskt förklarar ett semantiskt
// fel: felmeddelandet, filen, den SENASTE DIFFEN (felet är oftast nyss infört)
// och headers ur de filer den här filen importerar. Att skicka hela repot vore
// meningslöst -- 3B har 8192 tokens.
import * as vscode from "vscode";
import {
  clampToLines,
  ensureInstructReady,
  instructAvailable,
  instructCode,
  instructUnavailableMessage,
} from "./instructModel.js";
import { isSyntaxDiagnostic } from "./fim/syntaxSignal.js";
import { confirmViaDiff } from "./preview.js";
import { pickRepository } from "./git.js";

/** Budget per kontextdel. Summan ska rymmas i 8192 tokens med marginal. */
const MAX_FILE_CHARS = 4000;
const MAX_DIFF_CHARS = 1500;
const MAX_IMPORT_CHARS = 1200;

/** Hur många importerade filer vi tittar i. Fler ger sämre svar, inte bättre. */
const MAX_IMPORTS = 3;

/**
 * PROMPTEN ÄR MÄTT FRAM MOT GRANITE, inte skriven på känsla. Läs innan du ändrar.
 *
 * Den första versionen slutade med "If you cannot fix it from what you were
 * given, output the file unchanged." Mot Qwen fungerade det. Mot Granite var
 * det en UTGÅNG modellen tog: på ett typfel den hade all information för att
 * laga returnerade den filen oförändrad.
 *
 * Tre ändringar fixade det, verifierade var för sig:
 *
 *   1. Eskapluckan borta, ersatt av ett PÅSTÅENDE om att felet går att laga.
 *   2. "Never invent fields, functions or imports" i stället, så att bortfallet
 *      av eskapluckan inte byts mot påhitt. Kontrollerat: ett PÅHITTAT fel på
 *      ren kod ger fortfarande filen oförändrad -- den fabricerar inte.
 *   3. Diffen FÖRE filen i prompten, och en konkret slutinstruktion
 *      ("Rewrite line N so the error goes away"). Granite viktar slutet av
 *      prompten tyngre än Qwen gjorde.
 */
const SYSTEM = [
  "You fix one specific error in a file.",
  "The error is real and it IS fixable from what you are given. Fix it.",
  "Output ONLY the complete corrected file. No explanation, no markdown fences.",
  "Change as little as possible: fix the reported error and nothing else.",
  "Preserve all formatting, comments and unrelated code exactly as they are.",
  "Never invent fields, functions or imports that do not appear in what you were given.",
].join("\n");

/** Diagnostikens kod, oavsett om den är ett tal, en sträng eller ett objekt. */
function codeOf(d: vscode.Diagnostic): string | number | undefined {
  if (d.code === undefined || d.code === null) {
    return undefined;
  }
  return typeof d.code === "object" ? d.code.value : d.code;
}

/** Fel som hör till DEN HÄR lanen: fel severity, och inte syntaktiska. */
function isSemanticError(d: vscode.Diagnostic): boolean {
  return (
    d.severity === vscode.DiagnosticSeverity.Error &&
    !isSyntaxDiagnostic(String(d.message), codeOf(d))
  );
}

/**
 * Relativa importsökvägar ur filen, som URI:er.
 *
 * Regexen är avsiktligt grov och täcker ES-import, require och pythons
 * from-import. Vi behöver inte en riktig modulupplösare: missar vi en import
 * blir svaret sämre, inte fel, och att bygga en upplösare per språk vore ett
 * eget projekt.
 */
function relativeImports(document: vscode.TextDocument): vscode.Uri[] {
  const text = document.getText();
  const found = new Set<string>();
  const patterns = [
    /(?:from|import)\s+["'](\.[^"']+)["']/g,
    /require\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      found.add(m[1]);
    }
  }

  const base = vscode.Uri.joinPath(document.uri, "..");
  const uris: vscode.Uri[] = [];
  for (const spec of found) {
    if (uris.length >= MAX_IMPORTS) {
      break;
    }
    // Ändelsen är ofta utelämnad. Vi provar de vanliga i stället för att
    // implementera nodes upplösningsalgoritm.
    const candidates = spec.match(/\.[a-z]+$/i)
      ? [spec]
      : [`${spec}.ts`, `${spec}.tsx`, `${spec}.js`, `${spec}.py`, `${spec}/index.ts`];
    for (const candidate of candidates) {
      uris.push(vscode.Uri.joinPath(base, candidate));
    }
  }
  return uris;
}

/** Läser början av de importerade filer som faktiskt finns. */
async function importContext(document: vscode.TextDocument): Promise<string> {
  const parts: string[] = [];
  let used = 0;

  for (const uri of relativeImports(document)) {
    if (used >= MAX_IMPORT_CHARS || parts.length >= MAX_IMPORTS) {
      break;
    }
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder().decode(bytes);
    } catch {
      continue; // kandidaten fanns inte -- helt normalt
    }
    const slice = clampToLines(text, Math.max(0, MAX_IMPORT_CHARS - used));
    if (!slice.trim()) {
      continue;
    }
    used += slice.length;
    parts.push(`--- ${vscode.workspace.asRelativePath(uri)} ---\n${slice}`);
  }

  return parts.join("\n\n");
}

/**
 * Den senaste diffen. Felet är oftast nyss infört, så det som ÄNDRATS är den
 * enskilt mest upplysande kontexten -- mer än filen i sig.
 *
 * Osparade ändringar syns inte i `git diff`; det är inte ett problem, för
 * filens aktuella innehåll skickas ändå med i sin helhet.
 */
async function recentDiff(document: vscode.TextDocument): Promise<string> {
  try {
    const repo = await pickRepository(document.uri);
    if (!repo) {
      return "";
    }
    const unstaged = await repo.diff(false);
    const staged = unstaged.trim() ? "" : await repo.diff(true);
    return clampToLines(unstaged.trim() || staged, MAX_DIFF_CHARS);
  } catch {
    return ""; // inget git-repo, eller git-extensionen är av
  }
}

async function buildPrompt(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): Promise<string> {
  const line = diagnostic.range.start.line + 1;
  const [diff, imports] = await Promise.all([
    recentDiff(document),
    importContext(document),
  ]);

  // ORDNINGEN ÄR MEDVETEN, och den ändrades när modellen byttes till Granite.
  //
  // Diffen ligger FÖRE filen. Det är diffen som bär svaret -- felet är oftast
  // nyss infört, och fältet som försvann finns bara där. Med filen först och
  // diffen sist tog Granite filen som facit och svarade "inget att ändra".
  //
  // Den konkreta slutinstruktionen ("Rewrite line N ...") ligger sist av samma
  // skäl: Granite viktar slutet av prompten tyngre än Qwen gjorde.
  const parts = [
    `Language: ${document.languageId}`,
    `File: ${vscode.workspace.asRelativePath(document.uri)}`,
    "",
    `Fix this error: ${diagnostic.message}`,
    `It is on line ${line}: ${document.lineAt(diagnostic.range.start.line).text.trim()}`,
  ];

  if (diff.trim()) {
    parts.push(
      "",
      "Recent changes -- the error was introduced by one of these, so the fix is here:",
      diff
    );
  }
  if (imports.trim()) {
    parts.push("", "Imported files:", imports);
  }

  parts.push("", "File:", clampToLines(document.getText(), MAX_FILE_CHARS));
  parts.push("", `Rewrite line ${line} so the error goes away. Output the whole corrected file.`);
  return parts.join("\n");
}

export function registerSemanticFix(ctx: vscode.ExtensionContext): void {
  // CodeAction-providern. Den KÖR INGENTING -- den erbjuder bara åtgärden.
  ctx.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      {
        provideCodeActions(document, _range, context) {
          if (!instructAvailable()) {
            return [];
          }
          return context.diagnostics.filter(isSemanticError).map((d) => {
            const action = new vscode.CodeAction(
              `$(sparkle) Freya: fix "${shorten(d.message)}"`,
              vscode.CodeActionKind.QuickFix
            );
            // COMMAND, inte EDIT. En edit hade betytt att modellen måste köras
            // redan när glödlampan ritas -- alltså vid varje
            // diagnostikuppdatering. Se filhuvudet, regel 1.
            action.command = {
              command: "freya.semanticFix",
              title: "Freya: fix this error",
              arguments: [document.uri, d],
            };
            action.diagnostics = [d];
            return action;
          });
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "freya.semanticFix",
      async (uri?: vscode.Uri, diagnostic?: vscode.Diagnostic) => {
        const editor = vscode.window.activeTextEditor;
        const document = uri
          ? await vscode.workspace.openTextDocument(uri)
          : editor?.document;
        if (!document) {
          vscode.window.showInformationMessage("Freya: no open file.");
          return;
        }

        // Anropad från paletten: ta det semantiska felet närmast markören.
        const target =
          diagnostic ??
          vscode.languages
            .getDiagnostics(document.uri)
            .filter(isSemanticError)
            .sort(
              (a, b) =>
                Math.abs(a.range.start.line - (editor?.selection.active.line ?? 0)) -
                Math.abs(b.range.start.line - (editor?.selection.active.line ?? 0))
            )[0];

        if (!target) {
          vscode.window.showInformationMessage(
            "Freya: no semantic error here. Syntax errors are handled inline as you type."
          );
          return;
        }

        // ensureInstructReady() HÄR, men instructAvailable() i CodeAction-
        // providern ovan. Skillnaden är inte godtycklig: det här är
        // kommandohandlaren, alltså något användaren själv utlöste (glödlampan
        // eller "Freya: Fix this error" i paletten), och då är en fråga om att
        // hämta modellen rätt svar. Providern ritar glödlampan och körs vid
        // varje diagnostikuppdatering -- den får aldrig öppna en dialog.
        if (!(await ensureInstructReady())) {
          vscode.window.showWarningMessage(`Freya: ${instructUnavailableMessage()}`);
          return;
        }

        const before = document.getText();

        const fixed = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Freya is working out a fix...",
            cancellable: true,
          },
          async (_progress, token) => {
            const ac = new AbortController();
            const sub = token.onCancellationRequested(() => ac.abort());
            try {
              return await instructCode({
                system: SYSTEM,
                user: await buildPrompt(document, target),
                maxTokens: Math.min(2400, Math.ceil(before.length / 3) + 256),
                signal: ac.signal,
              });
            } catch {
              return undefined;
            } finally {
              sub.dispose();
            }
          }
        );

        if (!fixed?.trim()) {
          vscode.window.showWarningMessage(
            "Freya: the model had no fix to offer for that error."
          );
          return;
        }

        if (fixed.trim() === before.trim()) {
          vscode.window.showInformationMessage(
            "Freya: the model left the file unchanged -- it could not fix that error from the context it had."
          );
          return;
        }

        const approved = await confirmViaDiff({
          before,
          after: fixed,
          languageId: document.languageId,
          title: `Freya: fix ${shorten(target.message)}`,
          question: `Freya suggests a fix for: ${shorten(target.message)}`,
        });
        if (!approved) {
          return;
        }

        // Filen kan ha ändrats medan diffen låg uppe.
        if (document.getText() !== before) {
          vscode.window.showWarningMessage(
            "Freya: the file changed while the diff was open. Nothing was applied."
          );
          return;
        }

        const whole = new vscode.Range(
          document.positionAt(0),
          document.positionAt(before.length)
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, whole, fixed);
        await vscode.workspace.applyEdit(edit);
      }
    )
  );
}

/** Felmeddelanden kan vara flera rader långa; menyer och rubriker kan inte. */
function shorten(message: string, max = 60): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}...`;
}
