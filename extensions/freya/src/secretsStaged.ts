// Hemlighetskoll på det som är stagat, alltså precis före en commit.
//
// OM ATT "BLOCKERA" EN COMMIT: git-extensionen exponerar ingen pre-commit-hook
// för andra extensions. En extension kan alltså inte hindra att någon trycker
// på Commit-knappen. Det som går -- och som det här gör -- är att skanna
// staged-diffen och stoppa de flöden vi själva äger:
//  - commit-generatorn (steg 6a), som är vägen in i en commit i praktiken,
//  - kommandot Freya: Skanna stagade ändringar för hemligheter.
// En hemlighet som redan ligger i en fil syns dessutom som diagnostik i
// Problem-panelen via secretsGuard.
import * as vscode from "vscode";
import { describeFindings, scanText, type SecretFinding } from "./secrets.js";
import { pickRepository, type GitRepository } from "./git.js";

/** Bara tillagda rader är intressanta: en borttagen hemlighet är en bra sak. */
function addedLines(diff: string): string {
  return diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

export function scanStagedDiff(diff: string): SecretFinding[] {
  return scanText(addedLines(diff));
}

/**
 * Returnerar true om det är okej att fortsätta. Vid träff frågar den, så att
 * en medveten commit av t.ex. en testnyckel fortfarande är möjlig -- men den
 * kräver ett aktivt val.
 */
export async function confirmStagedIsClean(
  repo: GitRepository,
  continueLabel: string
): Promise<boolean> {
  if (
    !vscode.workspace
      .getConfiguration("freya")
      .get<boolean>("secrets.enabled", true)
  ) {
    return true;
  }

  const diff = await repo.diff(true);
  const findings = scanStagedDiff(diff);
  if (findings.length === 0) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `Freya: ${describeFindings(findings)} bland de stagade ändringarna.`,
    {
      modal: true,
      detail:
        `${findings.map((f) => `• ${f.label}: ${f.preview}`).join("\n")}\n\n` +
        "En hemlighet som committas finns kvar i historiken även om du tar bort " +
        "den i nästa commit. Ta bort den ur staged-ändringarna först.",
    },
    continueLabel
  );

  return choice === continueLabel;
}

export function registerStagedSecretScan(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "freya.scanStagedForSecrets",
      async (repoArg?: { rootUri?: vscode.Uri }) => {
        const repo = await pickRepository(repoArg?.rootUri);
        if (!repo) {
          vscode.window.showWarningMessage(
            "Freya: hittade inget git-repo i arbetsytan."
          );
          return;
        }
        const diff = await repo.diff(true);
        if (!diff.trim()) {
          vscode.window.showInformationMessage(
            "Freya: inget är stagat att skanna."
          );
          return;
        }
        const findings = scanStagedDiff(diff);
        if (findings.length === 0) {
          vscode.window.showInformationMessage(
            "Freya: inga hemligheter hittades i de stagade ändringarna."
          );
          return;
        }
        await vscode.window.showWarningMessage(
          `Freya: ${describeFindings(findings)} bland de stagade ändringarna.`,
          {
            modal: true,
            detail: findings
              .map((f) => `• ${f.label}: ${f.preview}`)
              .join("\n"),
          }
        );
      }
    )
  );
}
