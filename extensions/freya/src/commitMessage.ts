// Commit-generator: läser `git diff --staged` och föreslår ett meddelande.
//
// TVÅ LOKALA MODELLER, I TUR OCH ORDNING. Ingen av dem är molnet.
//
//   1. Den inbäddade 1.5B:n med en few-shot-prompt. Att sammanfatta en diff i
//      en rad är i praktiken en fortsättningsuppgift när man visar mönstret,
//      och 1.5B gör det på ~1 sekund. Den är förstahandsvalet.
//
//   2. Den inbäddade 3B-instruct:en om 1.5B:n saknas. Den läser instruktionen
//      i stället för att härma exempel, så den behöver ingen few-shot.
//
// RESERVEN BYTTES I FAS R. Den var tidigare Ollama med qwen2.5-coder:14b,
// alltså 9 GB som användaren själv måste hämta innan commit-rubriker
// fungerade på en maskin utan inbäddad runtime. Nu är båda stegen inbäddade,
// och en ren installation har aldrig ett läge där funktionen kräver en
// nedladdning.
import * as vscode from "vscode";
import { pickRepository, type GitRepository } from "./git.js";
import { confirmStagedIsClean } from "./secretsStaged.js";
import { localComplete } from "./localModel.js";
import { instructAvailable, instructOneShot } from "./instructModel.js";

// Diffen kan vara enorm. Modellen behöver riktningen, inte varje rad.
const MAX_DIFF_CHARS = 12_000;

// Instruktionen "högst 50 tecken" räcker inte -- qwen2.5-coder:14b svarade
// stabilt med 60-70 tecken på den. Med RÄKNADE exempel landar den på ~43.
// Exemplen är medvetet orelaterade till kod-diffar så att modellen inte
// härmar deras innehåll i stället för att beskriva den faktiska ändringen.
const SYSTEM = [
  "You write commit messages. Reply with ONLY the message.",
  "",
  "THE SUBJECT (first line) is what matters most:",
  "- AT MOST 50 CHARACTERS. Count them. A 60-character subject is a WRONG answer.",
  "- Imperative mood: 'add', 'fix', 'remove'.",
  "- No trailing period. No prefixes such as 'feat:' or 'fix:'.",
  "",
  "Examples of CORRECT subjects (count the characters):",
  "  fix crash when the file is missing       (33 characters)",
  "  remove unused import                     (20 characters)",
  "  switch cache key to project id           (30 characters)",
  "",
  "After the subject: a blank line, then at most three '- ' bullets if needed.",
  "Describe WHAT the change does, not which files were touched.",
  "No markdown, no quotes, no code blocks.",
].join("\n");

/** Rubrikbudget. Modellen instrueras om den; koden garanterar den. */
const MAX_SUBJECT = 50;

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return (
    diff.slice(0, MAX_DIFF_CHARS) +
    `\n\n[... diff truncated, ${diff.length - MAX_DIFF_CHARS} characters remaining]`
  );
}

/** Modellen svarar ibland med kodblock eller citattecken trots instruktionen. */
export function cleanMessage(raw: string): string {
  let text = raw.trim();

  // Fenced block runt hela svaret.
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) {
    text = fenced[1].trim();
  }

  const lines = text.split(/\r?\n/);
  // Modellen inleder ibland med "Här är ett förslag:".
  while (lines.length > 1 && /^(here (is|are)|suggestion|suggested|commit message)\b/i.test(lines[0])) {
    lines.shift();
    while (lines.length && lines[0].trim() === "") {
      lines.shift();
    }
  }

  if (lines.length) {
    // Omgivande citattecken på rubriken.
    lines[0] = lines[0].replace(/^["'`]+|["'`]+$/g, "").replace(/\.$/, "").trim();
    // Sista utposten om modellen ändå struntade i teckenbudgeten: klipp på
    // ordgräns hellre än mitt i ett ord. Resten av meddelandet står kvar, så
    // ingen information försvinner -- den flyttar bara ner i brödtexten.
    if (lines[0].length > MAX_SUBJECT) {
      const overflow = lines[0];
      const cut = overflow.lastIndexOf(" ", MAX_SUBJECT);
      lines[0] = overflow.slice(0, cut > 20 ? cut : MAX_SUBJECT).trim();
      const rest = overflow.slice(lines[0].length).trim();
      if (rest) {
        lines.splice(1, 0, "", rest);
      }
    }
  }

  return lines.join("\n").trim();
}

/**
 * Few-shot-prompt för den INBÄDDADE base-modellen. En base-modell följer inte
 * instruktioner — den fortsätter mönstret den ser, så budskapet "kort, imperativ
 * svensk rubrik" måste demonstreras i stället för beskrivas. Exemplen är korta
 * med flit: de sätter längden lika mycket som de sätter formen.
 */
function fewShotCommitPrompt(diff: string): string {
  return [
    "# Write a short commit subject in English for each diff.",
    "",
    "## Diff",
    "+function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }",
    "## Subject",
    "add clamp helper",
    "",
    "## Diff",
    "-const PORT = 3000;",
    "+const PORT = Number(process.env.PORT ?? 3000);",
    "## Subject",
    "read port from environment variable",
    "",
    "## Diff",
    truncateDiff(diff),
    "## Subject",
    "",
  ].join("\n");
}

/** Inbäddad modell först. undefined = ingen lokal modell, kör Ollama i stället. */
async function generateLocal(
  diff: string,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());
  try {
    const out = await localComplete(fewShotCommitPrompt(diff), {
      // Rubriken är en rad. Stoppa på radbrytning och på nästa exempel-rubrik,
      // annars fortsätter base-modellen att hitta på fler diffar.
      stop: ["\n", "## "],
      maxTokens: 32,
      temperature: 0.2,
      signal: ac.signal,
    });
    return out === undefined ? undefined : cleanMessage(out);
  } finally {
    sub.dispose();
  }
}

/**
 * Reserven: den inbäddade 3B-instruct:en. Den läser SYSTEM som en instruktion
 * i stället för att härma few-shot-exemplen, vilket är hela skillnaden mellan
 * de två modellerna.
 */
async function generateViaInstruct(
  diff: string,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());
  try {
    const out = await instructOneShot({
      system: SYSTEM,
      user: `Write a commit message for this diff:\n\n${truncateDiff(diff)}`,
      maxTokens: 160,
      temperature: 0.2,
      signal: ac.signal,
    });
    return out === undefined ? undefined : cleanMessage(out);
  } finally {
    sub.dispose();
  }
}

async function run(repoArg?: GitRepository | { rootUri?: vscode.Uri }): Promise<void> {
  // SCM-knappen skickar med sitt repo-objekt; paletten skickar inget.
  const fromArg =
    repoArg && typeof (repoArg as GitRepository).diff === "function"
      ? (repoArg as GitRepository)
      : undefined;
  const repo = fromArg ?? (await pickRepository(repoArg?.rootUri));

  if (!repo) {
    vscode.window.showWarningMessage(
      "Freya: no git repository found in the workspace."
    );
    return;
  }

  const diff = await repo.diff(true);
  if (!diff.trim()) {
    vscode.window.showInformationMessage(
      "Freya: nothing is staged. Add changes with git add first."
    );
    return;
  }

  // Hemlighetskoll på det som ska committas, innan vi ens skriver ett
  // meddelande åt det. Se secretsStaged.ts om varför blockeringen sitter här
  // och inte i git-extensionens commit-knapp.
  if (!(await confirmStagedIsClean(repo, "Write message anyway"))) {
    return;
  }

  const message = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: "Freya is writing a commit message...",
      cancellable: true,
    },
    async (_progress, token) => {
      const local = await generateLocal(diff, token);
      if (local !== undefined && local.trim()) {
        return local;
      }
      return generateViaInstruct(diff, token).catch(() => undefined);
    }
  );

  if (!message) {
    vscode.window.showWarningMessage(
      instructAvailable()
        ? "Freya: the local model returned no message. Try again."
        : "Freya: no local model is installed in this build, so there is nothing to write the message."
    );
    return;
  }

  // Förslaget läggs i commit-fältet så att det går att redigera innan commit.
  // Ersätter inte något användaren redan skrivit utan att fråga.
  const existing = repo.inputBox.value.trim();
  if (existing && existing !== message) {
    const choice = await vscode.window.showInformationMessage(
      "Freya: there is already text in the commit box.",
      { modal: true, detail: `Suggestion:\n\n${message}` },
      "Replace",
      "Append"
    );
    if (choice === "Replace") {
      repo.inputBox.value = message;
    } else if (choice === "Append") {
      repo.inputBox.value = `${existing}\n\n${message}`;
    }
    return;
  }

  repo.inputBox.value = message;
}

export function registerCommitMessage(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.generateCommitMessage", run)
  );
}
