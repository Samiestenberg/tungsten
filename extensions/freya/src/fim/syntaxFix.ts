// FAS B4: syntaxfix som SVAG ghost-text, i realtid.
//
// Tvåstegsfelsökningen, steg 1. Se syntaxSignal.ts för var gränsen mot
// 3B-lanen går och varför.
//
// När parsern säger att något fattas skickar vi INTE till 3B. Vi skickar FIM
// till 1.5B: prefix = koden före markören, suffix = koden efter, luckan = det
// som saknas för att det ska parsa. Det sker medan användaren skriver, utan
// fördröjning värd namnet, och kostar ~200 ms.
//
// VARFÖR EN DEKORATION OCH INTE EN INLINE COMPLETION: förslaget ska se
// SVAGARE ut än vanlig autocomplete. Det är en gissning om något användaren
// inte bad om, till skillnad från kompletteringen hen framkallade genom att
// skriva. VS Codes inline-förslag har en fast stil; en dekoration kan sättas
// till lägre opacitet. Skillnaden i utseende ÄR budskapet: "det här är svagare
// än det andra vi visar dig".
//
// Tab tas bara när förslaget syns (kontextnyckeln freya.syntaxFixVisible) och
// inte när suggest-widgeten eller ett vanligt inline-förslag redan äger Tab.
import * as vscode from "vscode";
import { fimContext, isEditableDocument, runFim } from "./fimCore.js";
import { isSyntaxDiagnostic, isUsefulGap, sanitizeGap } from "./syntaxSignal.js";

function cfg() {
	return vscode.workspace.getConfiguration("freya");
}

/** Kontextnyckeln som gör Tab till "acceptera" och inget annat. */
const CONTEXT_KEY = "freya.syntaxFixVisible";

/**
 * Diagnostiken ändras vid varje tangenttryck medan man skriver. Att fyra en
 * FIM per ändring hade betytt en modellkörning per tecken; 350 ms är den paus
 * som skiljer "skriver fortfarande" från "skrev fel".
 */
const DEBOUNCE_MS = 350;

/** Luckan är två tecken, inte två rader. Budgeten är satt efter det. */
const GAP_TOKEN_CAP = 16;

/**
 * Hur långt från markören ett fel får ligga för att räknas. Ett parsefel
 * längst ner i filen medan man skriver högst upp är inte det man håller på med.
 */
const NEAR_LINES = 2;

interface Ghost {
	uri: vscode.Uri;
	position: vscode.Position;
	gap: string;
}

let visible: Ghost | undefined;
let decoration: vscode.TextEditorDecorationType | undefined;
let timer: NodeJS.Timeout | undefined;
let inFlight: AbortController | undefined;

async function setVisible(ghost: Ghost | undefined): Promise<void> {
	visible = ghost;
	await vscode.commands.executeCommand("setContext", CONTEXT_KEY, !!ghost);

	if (!decoration) {
		return;
	}
	for (const editor of vscode.window.visibleTextEditors) {
		if (!ghost || editor.document.uri.toString() !== ghost.uri.toString()) {
			editor.setDecorations(decoration, []);
			continue;
		}
		editor.setDecorations(decoration, [
			{
				range: new vscode.Range(ghost.position, ghost.position),
				renderOptions: { after: { contentText: ghost.gap } },
			},
		]);
	}
}

/** Fel som är syntaktiska OCH nära markören. */
function nearbySyntaxError(
	document: vscode.TextDocument,
	cursor: vscode.Position
): vscode.Diagnostic | undefined {
	return vscode.languages
		.getDiagnostics(document.uri)
		.find(
			(d) =>
				d.severity === vscode.DiagnosticSeverity.Error &&
				Math.abs(d.range.start.line - cursor.line) <= NEAR_LINES &&
				isSyntaxDiagnostic(
					typeof d.message === "string" ? d.message : String(d.message),
					typeof d.code === "object" ? d.code.value : d.code
				)
		);
}

async function proposeFix(editor: vscode.TextEditor): Promise<void> {
	const document = editor.document;
	const cursor = editor.selection.active;

	if (!nearbySyntaxError(document, cursor)) {
		await setVisible(undefined);
		return;
	}

	inFlight?.abort();
	const ac = new AbortController();
	inFlight = ac;

	const offset = document.offsetAt(cursor);
	const { prefix, suffix } = fimContext(document, offset);

	let raw: string | undefined;
	try {
		raw = await runFim({
			prefix,
			suffix,
			maxTokens: GAP_TOKEN_CAP,
			stop: ["\n"],
			signal: ac.signal,
		});
	} catch {
		// Ingen gissning. Ett uteblivet förslag kostar användaren ingenting.
		await setVisible(undefined);
		return;
	}

	if (raw === undefined || ac.signal.aborted) {
		await setVisible(undefined);
		return;
	}

	const gap = sanitizeGap(raw);
	if (!isUsefulGap(gap)) {
		await setVisible(undefined);
		return;
	}

	// Markören kan ha flyttat sig medan modellen tänkte. Att visa luckan på fel
	// ställe är värre än att inte visa den.
	if (
		vscode.window.activeTextEditor !== editor ||
		!editor.selection.active.isEqual(cursor)
	) {
		return;
	}

	await setVisible({ uri: document.uri, position: cursor, gap });
}

function schedule(): void {
	if (timer) {
		clearTimeout(timer);
	}
	if (!cfg().get<boolean>("syntaxFix.enabled", true)) {
		void setVisible(undefined);
		return;
	}
	timer = setTimeout(() => {
		timer = undefined;
		const editor = vscode.window.activeTextEditor;
		if (editor && isEditableDocument(editor.document)) {
			void proposeFix(editor);
		}
	}, DEBOUNCE_MS);
	timer.unref?.();
}

export function registerSyntaxFix(ctx: vscode.ExtensionContext): void {
	decoration = vscode.window.createTextEditorDecorationType({
		after: {
			color: new vscode.ThemeColor("editorGhostText.foreground"),
			fontStyle: "italic",
			// SVAGARE än vanlig ghost-text. Se filhuvudet: skillnaden i
			// utseende ÄR budskapet.
			//
			// Opaciteten går genom textDecoration och inte genom ett eget fält:
			// DecorationRenderOptions har inget `opacity`, men fälten är
			// dokumenterade som "CSS styling property that will be applied", och
			// de sätts som CSS. `none;` avslutar textDecoration-deklarationen så
			// att opacity blir en egen regel i stället för skräp i samma.
			//
			// Alternativet hade varit en rgba-färg, men då tappar vi
			// editorGhostText.foreground och får en ghost-text som inte följer
			// användarens tema.
			textDecoration: "none; opacity: 0.45",
		},
	});
	ctx.subscriptions.push(decoration);

	ctx.subscriptions.push(
		// Diagnostiken är signalen. Den kommer från språkservern, alltså från en
		// riktig parser -- vi gissar inte själva på om koden är trasig.
		vscode.languages.onDidChangeDiagnostics((e) => {
			const active = vscode.window.activeTextEditor;
			if (
				active &&
				e.uris.some((u) => u.toString() === active.document.uri.toString())
			) {
				schedule();
			}
		}),

		// Markören flyttade sig: den gamla luckan hör till den gamla platsen.
		vscode.window.onDidChangeTextEditorSelection((e) => {
			if (visible && !e.selections[0]?.active.isEqual(visible.position)) {
				void setVisible(undefined);
			}
		}),

		vscode.window.onDidChangeActiveTextEditor(() => {
			void setVisible(undefined);
		}),

		vscode.workspace.onDidChangeTextDocument(() => {
			// Användaren skrev vidare. Luckan gällde texten som var.
			if (visible) {
				void setVisible(undefined);
			}
		})
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("freya.syntaxFix.accept", async () => {
			const ghost = visible;
			if (!ghost) {
				return;
			}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.uri.toString() !== ghost.uri.toString()) {
				await setVisible(undefined);
				return;
			}
			// Rensa FÖRE insättningen: onDidChangeTextDocument städar annars
			// bort dekorationen mitt i, och kontextnyckeln hinner blinka.
			const gap = ghost.gap;
			const at = ghost.position;
			await setVisible(undefined);
			await editor.edit((builder) => builder.insert(at, gap));
		}),

		vscode.commands.registerCommand("freya.syntaxFix.dismiss", async () => {
			await setVisible(undefined);
		})
	);

	ctx.subscriptions.push({ dispose: () => void setVisible(undefined) });
}
