// FAS C4: generera tester. Instruct-lanen (3B, port 11436).
//
// GRÄNSEN MOT 1.5B:s TEST-SKELETT (fim/tentative.ts): skelettet ger STRUKTUREN
// -- it(), expect() -- utifrån vad som redan står i filen. Det här ger
// INNEHÅLLET: vad kontraktet faktiskt är och vilka fall som kan gå sönder.
// Skillnaden är omdöme, och omdöme kräver att modellen läser en instruktion.
//
// Att blanda ihop dem ger den värsta sortens testfil: en som ser rimlig ut och
// inte testar något.
//
// RAMVERKET DETEKTERAS, det frågas inte om. Ett genererat test i fel ramverk
// är värdelöst på ett särskilt irriterande sätt -- det ser rätt ut, det körs
// inte, och felet syns först när man kör suiten. Repot vet redan svaret.
// Se testFramework.ts.
//
// RESULTATET SPARAS INTE AUTOMATISKT. Det öppnas som ett namnlöst dokument
// bredvid koden, med den föreslagna sökvägen i rubriken. Att skriva en fil
// användaren inte bett om är precis den sortens sak regel 3 finns för.
import * as vscode from "vscode";
import {
  ensureInstructReady,
  clampToLines,
  instructCode,
  instructFailureMessage,
  instructUnavailableMessage,
} from "./instructModel.js";
import {
  FALLBACK_FRAMEWORK,
  frameworkFromLanguage,
  frameworkFromPackageJson,
  mochaUi,
  testPathFor,
  type TestFramework,
} from "./testFramework.js";
import { pruneGeneratedTests } from "./testPrune.js";

/** Taket på koden som skickas in. 3B har 8192 tokens totalt. */
const MAX_CODE_CHARS = 5000;

const SYSTEM = [
  "You write unit tests for code you are given.",
  "Output ONLY the test file. No explanation, no markdown fences.",
  "Cover the contract: the normal case, the boundaries, and the ways it can fail.",
  "Prefer a few tests that would actually catch a bug over many that restate the code.",
  "Give each test a name that says what behaviour it protects.",
  "Do not invent functions that are not in the code you were given.",
].join("\n");

/**
 * Ramverket, i tre steg: repot först, sedan språket, sedan en gissning.
 *
 * package.json läses ur den arbetsytemapp filen faktiskt ligger i -- i ett
 * monorepo är rotens package.json inte nödvändigtvis den som gäller.
 */
async function detectFramework(
  document: vscode.TextDocument
): Promise<TestFramework> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    for (const dir of packageJsonCandidates(document.uri, folder.uri)) {
      const pkg = await readJson(vscode.Uri.joinPath(dir, "package.json"));
      if (!pkg) {
        continue;
      }
      const found = frameworkFromPackageJson(pkg);
      if (found?.name.startsWith("Mocha")) {
        return mochaUi(pkg, await readText(vscode.Uri.joinPath(dir, ".mocharc.json")));
      }
      if (found) {
        return found;
      }
    }
  }
  return frameworkFromLanguage(document.languageId) ?? FALLBACK_FRAMEWORK;
}

/**
 * Mapparna att leta package.json i: filens egen mapp och uppåt till
 * arbetsytans rot. Närmast filen vinner, vilket är rätt i ett monorepo.
 */
function packageJsonCandidates(
  file: vscode.Uri,
  root: vscode.Uri
): vscode.Uri[] {
  const dirs: vscode.Uri[] = [];
  let current = vscode.Uri.joinPath(file, "..");
  for (let i = 0; i < 8; i++) {
    dirs.push(current);
    if (current.path === root.path || current.path.length <= root.path.length) {
      break;
    }
    current = vscode.Uri.joinPath(current, "..");
  }
  return dirs;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function readJson(uri: vscode.Uri): Promise<unknown | undefined> {
  const text = await readText(uri);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // trasig package.json är inte vårt problem att rapportera
  }
}

function userPrompt(
  code: string,
  languageId: string,
  framework: TestFramework,
  importPath: string
): string {
  return [
    `Language: ${languageId}`,
    `Test framework: ${framework.name}`,
    `Import the code under test from: ${importPath}`,
    "",
    "Start the file like this:",
    framework.importLine,
    "",
    "Code under test:",
    clampToLines(code, MAX_CODE_CHARS),
    "",
    "Write the test file.",
  ].join("\n");
}

/** Importsökvägen från testfilen till källfilen, i den form språket vill ha. */
function importSpecifier(sourcePath: string, languageId: string): string {
  const file = sourcePath.replace(/\\/g, "/").split("/").pop() ?? sourcePath;
  const stem = file.replace(/\.[^.]+$/, "");
  if (languageId === "python") {
    return stem;
  }
  if (languageId === "go" || languageId === "rust") {
    return "the same package";
  }
  // TS-projekt skriver ./x.js i ESM-läge och ./x annars. Vi föreslår ./x och
  // låter användaren rätta -- att gissa modulsystemet fel ger ett fel som är
  // svårare att se än en saknad ändelse.
  return `./${stem}`;
}

export function registerGenerateTests(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.generateTests", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Freya: no open file.");
        return;
      }

      // Markering = testa just det. Ingen markering = testa hela filen.
      const code = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);

      if (!code.trim()) {
        vscode.window.showInformationMessage("Freya: nothing to test here.");
        return;
      }

      if (!(await ensureInstructReady())) {
        vscode.window.showWarningMessage(`Freya: ${instructUnavailableMessage()}`);
        return;
      }

      const framework = await detectFramework(editor.document);
      const sourcePath = vscode.workspace.asRelativePath(editor.document.uri);
      const testPath = testPathFor(sourcePath, framework);

      // Felet fran modellanropet, sparat i stallet for bortkastat. Utan det
      // rapporterades en nere server som "modellen hade inget att saga".
      // Se instructFailureMessage() i instructModel.ts.
      let failure: unknown;
      const tests = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Freya is writing ${framework.name} tests...`,
          cancellable: true,
        },
        async (_progress, token) => {
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            return await instructCode({
              system: SYSTEM,
              user: userPrompt(
                code,
                editor.document.languageId,
                framework,
                importSpecifier(sourcePath, editor.document.languageId)
              ),
              // Taket är satt efter en MÄTNING, inte efter vad som verkade
              // rimligt: med 800 tokens fortsatte 3B i 50 sekunder och
              // producerade ett dussin nästan identiska testfall innan taket
              // tog slut mitt i en sträng. Se testPrune.ts. Ett lägre tak plus
              // klippningen ger färre och bättre tester på en tredjedel av
              // tiden.
              maxTokens: 700,
              signal: ac.signal,
            });
          } catch (err) {
            failure = err;
            return undefined;
          } finally {
            sub.dispose();
          }
        }
      );

      if (!tests?.trim()) {
        vscode.window.showWarningMessage(
          instructFailureMessage(failure) ??
            "Freya: the model returned no tests. Try selecting a single function."
        );
        return;
      }

      // Klipp degenererade upprepningar och balansera ett avhugget svar.
      // Se testPrune.ts -- det här är inte defensiv paranoia utan en fix på
      // ett beteende som mättes upp.
      const pruned = pruneGeneratedTests(tests);

      // Namnlöst dokument, inte en sparad fil. Se filhuvudet.
      const header = [
        `// Freya generated these ${framework.name} tests for ${sourcePath}.`,
        `// Suggested location: ${testPath}`,
        "// Read them before you keep them -- they are a starting point, not a suite.",
        "",
      ].join("\n");

      const doc = await vscode.workspace.openTextDocument({
        content: header + pruned.trimEnd() + "\n",
        language: framework.languageId,
      });
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    })
  );
}
