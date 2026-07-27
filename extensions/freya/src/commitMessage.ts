// Commit-generator: läser `git diff --staged` och föreslår ett meddelande.
//
// Kör lokalt mot Ollama, aldrig mot molnet -- det ska vara gratis och fungera
// offline även när chatten är satt till workersai.
//
// Vi anropar /api/chat direkt i stället för att återanvända OllamaProvider:
// den har agentens system-prompt ("du är en kodagent som arbetar med filer",
// verktygsregler) inbakad, vilket är precis fel instruktion för den här
// uppgiften.
import * as vscode from "vscode";
import { commitModel, ollamaUrl } from "./config.js";
import { probeOllama, ollamaGuidance, hasModel } from "./health.js";
import { pickRepository, type GitRepository } from "./git.js";

// Diffen kan vara enorm. Modellen behöver riktningen, inte varje rad.
const MAX_DIFF_CHARS = 12_000;

// Instruktionen "högst 50 tecken" räcker inte -- qwen2.5-coder:14b svarade
// stabilt med 60-70 tecken på den. Med RÄKNADE exempel landar den på ~43.
// Exemplen är medvetet orelaterade till kod-diffar så att modellen inte
// härmar deras innehåll i stället för att beskriva den faktiska ändringen.
const SYSTEM = [
  "Du skriver commit-meddelanden. Svara med ENDAST meddelandet.",
  "",
  "RUBRIKEN (första raden) är det viktigaste:",
  "- HÖGST 50 TECKEN. Räkna. En rubrik på 60 tecken är FEL svar.",
  "- Imperativ svenska: 'lägg till', 'fixa', 'ta bort'.",
  "- Ingen punkt på slutet. Inga prefix som 'feat:' eller 'fix:'.",
  "",
  "Exempel på RÄTT rubriker (räkna tecknen):",
  "  fixa krasch när filen saknas             (27 tecken)",
  "  ta bort oanvänd import                   (22 tecken)",
  "  byt cache-nyckel till projekt-id         (32 tecken)",
  "",
  "Efter rubriken: tom rad, sedan högst tre punkter '- ' om det behövs.",
  "Beskriv VAD ändringen gör, inte vilka filer som rörts.",
  "Ingen markdown, inga citattecken, inga kodblock.",
].join("\n");

/** Rubrikbudget. Modellen instrueras om den; koden garanterar den. */
const MAX_SUBJECT = 50;

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return (
    diff.slice(0, MAX_DIFF_CHARS) +
    `\n\n[... diffen klippt, ${diff.length - MAX_DIFF_CHARS} tecken kvar]`
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
  while (lines.length > 1 && /^(här (är|kommer)|förslag|commit)\b/i.test(lines[0])) {
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

async function generate(
  diff: string,
  model: string,
  url: string,
  token: vscode.CancellationToken
): Promise<string> {
  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Skriv ett commit-meddelande för den här diffen:\n\n${truncateDiff(diff)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    }
    const data: any = await res.json();
    return cleanMessage(String(data?.message?.content ?? ""));
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
      "Freya: hittade inget git-repo i arbetsytan."
    );
    return;
  }

  const diff = await repo.diff(true);
  if (!diff.trim()) {
    vscode.window.showInformationMessage(
      "Freya: inget är stagat. Lägg till ändringar med git add först."
    );
    return;
  }

  const url = ollamaUrl();
  const model = commitModel();
  const health = await probeOllama(url);
  if (!health.reachable || !hasModel(health, model)) {
    // Samma vägledning som chattpanelen ger, men här som notifiering.
    const guidance = ollamaGuidance(health, [model], url);
    vscode.window.showWarningMessage(
      `Freya: kan inte generera commit-meddelande. ${health.reachable ? `Modellen ${model} saknas — kör: ollama pull ${model}` : `Ollama svarar inte på ${url}.`}`
    );
    console.warn(`[freya] commit-generator: ${guidance}`);
    return;
  }

  const message = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: "Freya skriver commit-meddelande...",
      cancellable: true,
    },
    (_progress, token) => generate(diff, model, url, token)
  );

  if (!message) {
    vscode.window.showWarningMessage(
      "Freya: modellen gav inget meddelande. Försök igen."
    );
    return;
  }

  // Förslaget läggs i commit-fältet så att det går att redigera innan commit.
  // Ersätter inte något användaren redan skrivit utan att fråga.
  const existing = repo.inputBox.value.trim();
  if (existing && existing !== message) {
    const choice = await vscode.window.showInformationMessage(
      "Freya: det står redan text i commit-fältet.",
      { modal: true, detail: `Förslag:\n\n${message}` },
      "Ersätt",
      "Lägg till efter"
    );
    if (choice === "Ersätt") {
      repo.inputBox.value = message;
    } else if (choice === "Lägg till efter") {
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
