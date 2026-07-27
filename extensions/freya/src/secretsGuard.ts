// Kopplar hemlighets-skannern till redigeraren.
//
// Två ytor:
//  1. Inklistring (och annan bulk-insättning) -- varnar direkt och erbjuder
//     att ångra, alltså INNAN texten hinner sparas.
//  2. Diagnostik -- träffar syns i Problem-panelen och som markering i filen
//     så länge de ligger kvar.
//
// Om paste-API:t: VS Code har inget sätt för en extension att VÄGRA en
// inklistring. registerDocumentPasteEditProvider kan erbjuda alternativa
// inklistringar, inte blockera standardbeteendet. Därför läser vi
// onDidChangeTextDocument och backar med undo i stället -- resultatet för
// användaren är detsamma (texten hamnar inte i filen), och det fångar även
// bulk-insättningar som inte kom från urklipp.
import * as vscode from "vscode";
import { describeFindings, isSecretFile, scanText, type SecretFinding } from "./secrets.js";

/** Kortare insättningar än så här är någon som skriver, inte klistrar in. */
const BULK_INSERT_MIN = 24;

/** Skanna inte gigantiska filer vid varje tangenttryck. */
const MAX_DOC_CHARS = 1_000_000;

const DIAGNOSTIC_SOURCE = "Freya";

function enabled(): boolean {
  return vscode.workspace
    .getConfiguration("freya")
    .get<boolean>("secrets.enabled", true);
}

function scannable(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") {
    return false;
  }
  // En .env ÄR platsen för nycklar. Att varna där är brus -- se secrets.ts.
  if (isSecretFile(doc.uri.fsPath)) {
    return false;
  }
  return doc.getText().length <= MAX_DOC_CHARS;
}

function toDiagnostic(
  doc: vscode.TextDocument,
  finding: SecretFinding
): vscode.Diagnostic {
  const range = new vscode.Range(
    doc.positionAt(finding.index),
    doc.positionAt(finding.index + finding.length)
  );
  const d = new vscode.Diagnostic(
    range,
    `Möjlig hemlighet: ${finding.label} (${finding.preview}). Flytta den till .env eller OS-nyckelringen.`,
    vscode.DiagnosticSeverity.Warning
  );
  d.source = DIAGNOSTIC_SOURCE;
  d.code = finding.ruleId;
  return d;
}

export function registerSecretsGuard(ctx: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("freya-secrets");
  ctx.subscriptions.push(diagnostics);

  const timers = new Map<string, NodeJS.Timeout>();

  const refresh = (doc: vscode.TextDocument): void => {
    if (!enabled() || !scannable(doc)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const findings = scanText(doc.getText());
    diagnostics.set(
      doc.uri,
      findings.map((f) => toDiagnostic(doc, f))
    );
  };

  const refreshDebounced = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refresh(doc);
      }, 400)
    );
  };

  // Varning vid inklistring. Modal, för att en notifiering i hörnet hinner
  // missas innan filen sparas.
  const warnOnInsert = async (
    e: vscode.TextDocumentChangeEvent
  ): Promise<void> => {
    if (!enabled() || !scannable(e.document)) {
      return;
    }
    // Undo/redo triggar inte en ny varning -- annars går "Ångra" i loop.
    if (
      e.reason === vscode.TextDocumentChangeReason.Undo ||
      e.reason === vscode.TextDocumentChangeReason.Redo
    ) {
      return;
    }

    const inserted = e.contentChanges
      .map((c) => c.text)
      .filter((t) => t.length >= BULK_INSERT_MIN);
    if (inserted.length === 0) {
      return;
    }

    const findings = inserted.flatMap((t) => scanText(t));
    if (findings.length === 0) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Freya: ${describeFindings(findings)} i det du klistrade in.`,
      {
        modal: true,
        detail:
          `${findings.map((f) => `• ${f.label}: ${f.preview}`).join("\n")}\n\n` +
          "Hemligheter hör inte i källkod. Lägg dem i .env (som är gitignore:ad) " +
          "eller i OS-nyckelringen.",
      },
      "Ångra inklistringen",
      "Behåll"
    );

    if (choice === "Ångra inklistringen") {
      // Undo körs på den aktiva editorn; kontrollera att det fortfarande är
      // samma dokument innan vi ångrar något annat.
      if (
        vscode.window.activeTextEditor?.document.uri.toString() ===
        e.document.uri.toString()
      ) {
        await vscode.commands.executeCommand("undo");
      }
    }
  };

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      void warnOnInsert(e);
      refreshDebounced(e.document);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => refresh(doc)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      clearTimeout(timers.get(key));
      timers.delete(key);
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("freya.secrets.enabled")) {
        diagnostics.clear();
        vscode.workspace.textDocuments.forEach(refresh);
      }
    })
  );

  // Filer som redan är öppna när Freya aktiveras.
  vscode.workspace.textDocuments.forEach(refresh);
}
