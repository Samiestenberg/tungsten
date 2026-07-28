// FAS B1: next-edit prediction. VAR nästa ändring blir, och VAD den blir.
//
// Det här är funktionen som mest skiljer en smart editor från dum
// autocomplete: autocomplete svarar på "vad skriver jag härnäst HÄR",
// next-edit svarar på "vart ska jag härnäst, och vad ska stå där".
//
// KONSTRUKTIONEN, och varför den passar en 1.5B (se även nextEditMatch.ts):
// vi ber aldrig modellen resonera om avsikt. Vi noterar att användaren nyss
// ändrade en rad, letar upp de andra raderna som såg likadana ut, och låter
// FIM fylla i hur EN av dem borde se ut givet koden runt omkring. Modellen får
// en fråga den kan svara på; gissningen om avsikt görs av kod, inte av 1.5B.
//
// INGET APPLICERAS AUTOMATISKT. Förslaget syns som en dämpad skugga på raden,
// en statusrad att hoppa från och en CodeLens att godkänna med. Missar den är
// insatsen ett Esc.
import * as vscode from "vscode";
import { fimContext, isEditableDocument, runFim } from "./fimCore.js";
import { findEditSiblings, isMeaningfulEdit } from "./nextEditMatch.js";

function cfg() {
	return vscode.workspace.getConfiguration("freya");
}

/** Hur länge användaren ska ha slutat skriva innan vi gissar. */
const IDLE_MS = 1200;

/**
 * Filer större än så här hoppar vi över. Att jämföra 50 000 rader vid varje
 * tangenttryck skulle kosta mer än förslaget är värt.
 */
const MAX_LINES = 8000;

/** Hur många kandidater vi provar innan vi ger upp på den här ändringen. */
const MAX_CANDIDATES = 3;

/**
 * Tokenbudget för EN förutsagd rad. En rad är kort; taket finns för att en
 * modell utan radstopp gärna fortsätter skriva nästa funktion också.
 */
const LINE_TOKEN_CAP = 40;

interface Prediction {
	uri: vscode.Uri;
	/** Radnummer (0-baserat) där ändringen föreslås. */
	line: number;
	/** Radens nuvarande innehåll, så vi kan upptäcka att den ändrats under tiden. */
	currentText: string;
	/** Vad Freya tror ska stå där. */
	suggestedText: string;
}

let pending: Prediction | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let decoration: vscode.TextEditorDecorationType | undefined;
const lensChanged = new vscode.EventEmitter<void>();

/** Radögonblicksbilder per dokument, för att kunna se vad som STOD där förut. */
const snapshots = new Map<string, string[]>();

/**
 * Texter vi själva nyss föreslog via autocomplete. När en av dem dyker upp som
 * en ändring är det inte "något användaren gjorde" -- det är vårt eget förslag
 * som kom tillbaka, och att förutsäga vidare på det vore att jaga sin svans.
 */
const ourOwnCompletions = new Set<string>();

export function recordCompletionShown(_uri: vscode.Uri, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) {
		return;
	}
	ourOwnCompletions.add(trimmed);
	// Håll mängden liten. Den är en kortsiktig filtrering, inte en historik.
	if (ourOwnCompletions.size > 32) {
		ourOwnCompletions.delete(ourOwnCompletions.values().next().value!);
	}
}

function clearPrediction(): void {
	if (!pending) {
		return;
	}
	pending = undefined;
	statusItem?.hide();
	for (const editor of vscode.window.visibleTextEditors) {
		if (decoration) {
			editor.setDecorations(decoration, []);
		}
	}
	lensChanged.fire();
}

function showPrediction(prediction: Prediction): void {
	pending = prediction;

	statusItem!.text = `$(arrow-right) Next edit: line ${prediction.line + 1}`;
	statusItem!.tooltip = new vscode.MarkdownString(
		`Freya thinks the next change goes on line ${prediction.line + 1}:\n\n` +
		"```\n" + prediction.suggestedText.trim() + "\n```\n\n" +
		"Click to jump there."
	);
	statusItem!.show();

	paintDecoration();
	lensChanged.fire();
}

/** Den dämpade skuggan på den förutsagda raden. */
function paintDecoration(): void {
	if (!pending || !decoration) {
		return;
	}
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.uri.toString() !== pending.uri.toString()) {
			editor.setDecorations(decoration, []);
			continue;
		}
		if (pending.line >= editor.document.lineCount) {
			continue;
		}
		const range = editor.document.lineAt(pending.line).range;
		editor.setDecorations(decoration, [
			{
				range,
				renderOptions: {
					after: {
						// Förslaget visas EFTER raden, inte i stället för den:
						// användaren ska kunna läsa båda innan hen bestämmer sig.
						contentText: `  ${pending.suggestedText.trim()}`,
					},
				},
			},
		]);
	}
}

/**
 * Hittar raden som ändrades mellan två ögonblicksbilder.
 * undefined när det inte är en enkel enradsändring -- klistra-in av tio rader
 * är inte ett mönster att upprepa.
 */
function changedLine(
	before: readonly string[],
	after: readonly string[]
): { line: number; before: string; after: string } | undefined {
	if (before.length !== after.length) {
		return undefined; // rader tillkom eller försvann
	}
	let found: number | undefined;
	for (let i = 0; i < after.length; i++) {
		if (before[i] !== after[i]) {
			if (found !== undefined) {
				return undefined; // flera rader ändrade
			}
			found = i;
		}
	}
	return found === undefined
		? undefined
		: { line: found, before: before[found], after: after[found] };
}

/**
 * Gissar hur kandidatraden ska se ut, via FIM.
 *
 * Prompten är rå fill-in-the-middle: prefix = allt före raden, suffix = allt
 * efter den. Modellen ser alltså den REDAN ÄNDRADE raden ovanför i prefixet,
 * vilket är exakt signalen vi vill ge -- utan att någonsin skriva en
 * instruktion.
 */
async function predictLine(
	document: vscode.TextDocument,
	line: number,
	signal: AbortSignal
): Promise<string | undefined> {
	const lineRange = document.lineAt(line).range;
	const startOffset = document.offsetAt(lineRange.start);
	const endOffset = document.offsetAt(lineRange.end);

	const { prefix } = fimContext(document, startOffset);
	const suffixSource = fimContext(document, endOffset);

	const out = await runFim({
		prefix,
		suffix: suffixSource.suffix,
		maxTokens: LINE_TOKEN_CAP,
		stop: ["\n"],
		signal,
	});
	if (out === undefined) {
		return undefined;
	}
	const suggestion = out.split("\n")[0];
	return suggestion.trim() ? suggestion : undefined;
}

let idleTimer: NodeJS.Timeout | undefined;
let inFlight: AbortController | undefined;

async function predictAfterEdit(
	document: vscode.TextDocument,
	edit: { line: number; before: string; after: string }
): Promise<void> {
	inFlight?.abort();
	const ac = new AbortController();
	inFlight = ac;

	const lines = document.getText().split("\n");
	const siblings = findEditSiblings(lines, edit.before, edit.after, edit.line);

	for (const sibling of siblings.slice(0, MAX_CANDIDATES)) {
		if (ac.signal.aborted) {
			return;
		}
		let suggestion: string | undefined;
		try {
			suggestion = await predictLine(document, sibling.line, ac.signal);
		} catch {
			return; // modellen svarade inte; ett uteblivet förslag är gratis
		}
		if (!suggestion) {
			continue;
		}

		const currentText = lines[sibling.line];
		// Modellen föreslog det som redan står där. Inte en ändring.
		if (suggestion.trim() === currentText.trim()) {
			continue;
		}

		showPrediction({
			uri: document.uri,
			line: sibling.line,
			currentText,
			suggestedText: suggestion,
		});
		return;
	}
}

function onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
	const document = event.document;
	if (!isEditableDocument(document) || event.contentChanges.length === 0) {
		return;
	}

	const key = document.uri.toString();
	const before = snapshots.get(key);
	const after = document.getText().split("\n");

	// Ögonblicksbilden uppdateras ALLTID, även när vi inte gissar. Annars
	// jämför nästa ändring mot ett för gammalt tillstånd.
	if (after.length <= MAX_LINES) {
		snapshots.set(key, after);
	} else {
		snapshots.delete(key);
	}

	if (!cfg().get<boolean>("nextEdit.enabled", true)) {
		return;
	}

	// En ändring på annat håll gör den gamla förutsägelsen inaktuell.
	if (pending && pending.uri.toString() === key) {
		const stillThere =
			pending.line < document.lineCount &&
			document.lineAt(pending.line).text === pending.currentText;
		if (!stillThere) {
			clearPrediction();
		} else {
			paintDecoration();
		}
	}

	if (!before || after.length > MAX_LINES) {
		return;
	}

	const edit = changedLine(before, after);
	if (!edit || !isMeaningfulEdit(edit.before, edit.after)) {
		return;
	}
	// Vårt eget accepterade förslag är inte en användarändring.
	if (ourOwnCompletions.has(edit.after.trim())) {
		return;
	}

	if (idleTimer) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(() => {
		idleTimer = undefined;
		void predictAfterEdit(document, edit);
	}, IDLE_MS);
	idleTimer.unref?.();
}

export function registerNextEdit(ctx: vscode.ExtensionContext): void {
	statusItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		99
	);
	statusItem.command = "freya.nextEdit.jump";
	ctx.subscriptions.push(statusItem);

	decoration = vscode.window.createTextEditorDecorationType({
		// Svagare än vanlig ghost-text: det här är en gissning om något som
		// inte ens är där markören står, och ska se ut som en gissning.
		after: {
			color: new vscode.ThemeColor("editorGhostText.foreground"),
			fontStyle: "italic",
		},
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
	});
	ctx.subscriptions.push(decoration);

	// Ögonblicksbild när ett dokument öppnas eller byts till, annars finns
	// inget att jämföra den första ändringen mot.
	const snapshot = (document: vscode.TextDocument) => {
		if (!isEditableDocument(document)) {
			return;
		}
		const lines = document.getText().split("\n");
		if (lines.length <= MAX_LINES) {
			snapshots.set(document.uri.toString(), lines);
		}
	};
	vscode.workspace.textDocuments.forEach(snapshot);

	ctx.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(snapshot),
		vscode.workspace.onDidCloseTextDocument((d) => {
			snapshots.delete(d.uri.toString());
			if (pending?.uri.toString() === d.uri.toString()) {
				clearPrediction();
			}
		}),
		vscode.workspace.onDidChangeTextDocument(onDocumentChanged),
		vscode.window.onDidChangeVisibleTextEditors(() => paintDecoration())
	);

	// CodeLens ovanför den förutsagda raden. Den EXPLICITA vägen att godkänna:
	// inget appliceras av att man råkar stå på raden.
	ctx.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ pattern: "**" },
			{
				onDidChangeCodeLenses: lensChanged.event,
				provideCodeLenses(document) {
					if (!pending || pending.uri.toString() !== document.uri.toString()) {
						return [];
					}
					if (pending.line >= document.lineCount) {
						return [];
					}
					const range = document.lineAt(pending.line).range;
					return [
						new vscode.CodeLens(range, {
							title: "$(check) Apply Freya's next edit",
							command: "freya.nextEdit.apply",
						}),
						new vscode.CodeLens(range, {
							title: "Dismiss",
							command: "freya.nextEdit.dismiss",
						}),
					];
				},
			}
		)
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("freya.nextEdit.jump", async () => {
			if (!pending) {
				vscode.window.showInformationMessage(
					"Freya has no next-edit suggestion right now."
				);
				return;
			}
			const document = await vscode.workspace.openTextDocument(pending.uri);
			const editor = await vscode.window.showTextDocument(document);
			const range = document.lineAt(pending.line).range;
			editor.selection = new vscode.Selection(range.start, range.start);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			paintDecoration();
		}),

		vscode.commands.registerCommand("freya.nextEdit.apply", async () => {
			const prediction = pending;
			if (!prediction) {
				return;
			}
			const document = await vscode.workspace.openTextDocument(prediction.uri);
			// Raden kan ha ändrats sedan förslaget togs fram. Att skriva över
			// den ändå vore att kasta bort användarens arbete.
			if (
				prediction.line >= document.lineCount ||
				document.lineAt(prediction.line).text !== prediction.currentText
			) {
				vscode.window.showInformationMessage(
					"Freya: that line changed since the suggestion was made."
				);
				clearPrediction();
				return;
			}
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				prediction.uri,
				document.lineAt(prediction.line).range,
				prediction.suggestedText
			);
			await vscode.workspace.applyEdit(edit);
			clearPrediction();
		}),

		vscode.commands.registerCommand("freya.nextEdit.dismiss", () => {
			clearPrediction();
		})
	);

	ctx.subscriptions.push({ dispose: () => lensChanged.dispose() });
}
