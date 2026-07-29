// FAS C1: förklara kod i klarspråk. Instruct-lanen (3B, port 11436).
//
// VARFÖR 3B OCH INTE 1.5B: en förklaring är PROSA, inte en fortsättning på
// koden. Den gamla versionen körde en few-shot-prompt mot base-modellen och
// fick meningar som lät rätt men beskrev fel sak -- en base-modell härmar
// mönstret i exemplet i stället för att läsa koden. Instruct-modellen läser en
// instruktion, vilket är exakt vad den här uppgiften kräver.
//
// ENGELSKA MED FLIT. Små modeller är mätbart starkare på engelska än på
// svenska, och en förklaring som är fel på svenska är värre än en som är rätt
// på engelska.
//
// EXPLICIT AFFORDANS, INTE PASSIV HOVER. Det här är den viktigaste
// designbeslutet i filen. En hover som fyrar en modell vid varje muspaus
// skulle betyda en 3B-körning per gång musen råkar stanna över en symbol --
// på en maskin där modellen tar ~5 sekunder och 2 GB minne. Alltså:
//
//   * Hovern gör ALDRIG ett modellanrop. Den visar antingen ett cachat svar
//     eller en LÄNK som användaren får klicka på.
//   * Kommandot gör anropet, cachar svaret och öppnar hovern igen -- som nu
//     träffar cachen.
//
// Cachenyckeln är symbolen PLUS omgivningen (se instructText.cacheKey): samma
// `handle` i två filer är inte samma symbol, och en cache på bara namnet hade
// svarat med grannens förklaring.
import * as vscode from "vscode";
import {
  ensureInstructReady,
  cacheKey,
  clampToLines,
  instructAvailable,
  instructOneShot,
  INSTRUCT_MISSING,
} from "./instructModel.js";

/** Håll prompten liten. 3B har 8192 tokens och ska svara på sekunder. */
const MAX_CODE_CHARS = 3000;

/** Hur mycket omgivning som går in i cachenyckeln. */
const CONTEXT_CHARS = 400;

/** Cachetak. En förklaring är några hundra byte; taket finns mot obegränsad växt. */
const CACHE_LIMIT = 64;

const SYSTEM = [
  "You explain code to a developer who is reading it for the first time.",
  "Answer in English, in plain language, in at most three sentences.",
  "Say what the code does and why it is there. Do not restate it line by line.",
  "Reply with prose only: no code, no markdown headings, no bullet lists.",
].join("\n");

/**
 * Cachen. Insättningsordnad Map, äldst först -- delete+set på en träff flyttar
 * posten sist, vilket ger LRU utan en egen datastruktur.
 */
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, value: string): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value!);
  }
}

/**
 * Vad som ska förklaras, och nyckeln för det.
 *
 * Utan markering: symbolen markören står på (wordRangeAtPosition), inte hela
 * raden. Det är den som hovern handlar om, och det är den cachen ska nycklas
 * på.
 */
function target(
  document: vscode.TextDocument,
  selection: vscode.Selection | vscode.Position
): { range: vscode.Range; code: string; key: string } | undefined {
  let range: vscode.Range | undefined;

  if (selection instanceof vscode.Selection && !selection.isEmpty) {
    range = selection;
  } else {
    const position =
      selection instanceof vscode.Selection ? selection.active : selection;
    range =
      document.getWordRangeAtPosition(position) ??
      document.lineAt(position.line).range;
  }

  const code = document.getText(range).trim();
  if (!code) {
    return undefined;
  }

  // Omgivningen med i nyckeln: samma namn i olika sammanhang är olika saker.
  const start = document.offsetAt(range.start);
  const text = document.getText();
  const context = text.slice(
    Math.max(0, start - CONTEXT_CHARS),
    start + CONTEXT_CHARS
  );

  return {
    range,
    code,
    key: cacheKey(document.languageId, code, context),
  };
}

/** Prompten som faktiskt skickas. Kort och utan pynt -- 3B tappar långa regelverk. */
function userPrompt(code: string, languageId: string): string {
  return [
    `Language: ${languageId}`,
    "",
    clampToLines(code, MAX_CODE_CHARS),
    "",
    "Explain what this does.",
  ].join("\n");
}

/** Räknar ut förklaringen, eller undefined om ingen modell kunde svara. */
async function explain(
  code: string,
  languageId: string,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());
  try {
    const out = await instructOneShot({
      system: SYSTEM,
      user: userPrompt(code, languageId),
      maxTokens: 220,
      signal: ac.signal,
    });
    return out?.trim() || undefined;
  } finally {
    sub.dispose();
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

      const found = target(editor.document, editor.selection);
      if (!found) {
        vscode.window.showInformationMessage(
          "Freya: select some code (or put the cursor on a symbol)."
        );
        return;
      }

      if (cacheGet(found.key) !== undefined) {
        // Redan förklarad. Visa hovern i stället för att köra modellen igen.
        await vscode.commands.executeCommand("editor.action.showHover");
        return;
      }

      if (!(await ensureInstructReady())) {
        vscode.window.showWarningMessage(`Freya: ${INSTRUCT_MISSING}`);
        return;
      }

      const explanation = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Freya is explaining...",
          cancellable: true,
        },
        (_progress, token) =>
          explain(found.code, editor.document.languageId, token).catch(
            () => undefined
          )
      );

      if (!explanation) {
        vscode.window.showWarningMessage(
          "Freya: the instruct model had no answer. See the output channel 'Freya (instruct model)'."
        );
        return;
      }

      cachePut(found.key, explanation);
      // Hovern är rätt yta för svaret: den ligger vid koden det handlar om och
      // kräver ingen flik att stänga efteråt. Den träffar nu cachen.
      await vscode.commands.executeCommand("editor.action.showHover");
    })
  );

  // Hovern. GÖR ALDRIG ETT MODELLANROP. Se filhuvudet.
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      {
        provideHover(document, position) {
          const found = target(document, position);
          if (!found) {
            return undefined;
          }

          const cached = cacheGet(found.key);
          if (cached) {
            const md = new vscode.MarkdownString(
              `$(sparkle) **Freya**\n\n${cached}`
            );
            md.supportThemeIcons = true;
            return new vscode.Hover(md, found.range);
          }

          if (!instructAvailable()) {
            return undefined;
          }

          const md = new vscode.MarkdownString(
            `[$(sparkle) Explain this with Freya](command:freya.explainSelection) · runs locally`
          );
          md.isTrusted = { enabledCommands: ["freya.explainSelection"] };
          md.supportThemeIcons = true;
          return new vscode.Hover(md, found.range);
        },
      }
    )
  );
}
