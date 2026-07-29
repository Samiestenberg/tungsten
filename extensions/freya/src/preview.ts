// Diff-förhandsvisningen, delad av alla instruct-ytor som ändrar kod.
//
// REGEL 3 I ARKITEKTUREN, i kod: ingen 3B-ändring appliceras automatiskt.
// Semantiska ändringar visas alltid som en diff att godkänna -- särskilt i
// filer användaren inte aktivt redigerar. Att lägga funktionen HÄR och inte i
// varje yta för sig är det som gör regeln svår att glömma bort: det finns
// bara en väg från "modellen föreslog något" till "filen ändrades".
//
// VARFÖR EN RIKTIG DIFF-EDITOR OCH INTE EN MODAL MED TEXT I: en modal
// `detail`-sträng radbryts inte som kod, går inte att bläddra i och saknar
// syntaxfärgning. En omskriven funktion på trettio rader är oläslig där.
// Diff-editorn är ytan användaren redan läser ändringar i.
import * as vscode from "vscode";

const PREVIEW_SCHEME = "freya-preview";

/** Innehållet bakom preview-URI:erna. Rensas när diffen stängts. */
const previewContent = new Map<string, string>();

let counter = 0;

class PreviewProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		return previewContent.get(uri.toString()) ?? "";
	}
}

export function registerPreview(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			PREVIEW_SCHEME,
			new PreviewProvider()
		)
	);
}

export interface DiffPrompt {
	before: string;
	after: string;
	/** Sätter syntaxfärgningen i diffen. */
	languageId: string;
	/** Rubriken på diff-fliken. */
	title: string;
	/** Frågan i notifieringen. Default: "Freya suggests this change." */
	question?: string;
	/** Texten på ja-knappen. Default: "Apply". */
	applyLabel?: string;
}

/**
 * Öppnar diffen och frågar. true = användaren godkände.
 *
 * Diffen stängs alltid innan vi återvänder -- annars blir det en flik kvar som
 * visar en ändring som antingen redan är gjord eller aldrig blev av.
 */
export async function confirmViaDiff(prompt: DiffPrompt): Promise<boolean> {
	const id = ++counter;
	// Filändelsen i sökvägen är det som ger diffen syntaxfärgning.
	const suffix = prompt.languageId ? `.${prompt.languageId}` : "";
	const left = vscode.Uri.parse(`${PREVIEW_SCHEME}:/current-${id}${suffix}`);
	const right = vscode.Uri.parse(`${PREVIEW_SCHEME}:/freya-${id}${suffix}`);
	previewContent.set(left.toString(), prompt.before);
	previewContent.set(right.toString(), prompt.after);

	try {
		await vscode.commands.executeCommand(
			"vscode.diff",
			left,
			right,
			prompt.title,
			{ preview: true }
		);

		const answer = await vscode.window.showInformationMessage(
			prompt.question ?? "Freya suggests this change.",
			{ modal: false },
			prompt.applyLabel ?? "Apply",
			"Discard"
		);
		return answer === (prompt.applyLabel ?? "Apply");
	} finally {
		previewContent.delete(left.toString());
		previewContent.delete(right.toString());
		// activeTextEditor är inte satt för en diff, så vi går via kommandot
		// i stället för att leta upp fliken.
		await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
	}
}

/**
 * Visar ett nytt dokument bredvid, för svar som är TEXT och inte en ändring
 * (code-review-mini, genererade tester innan de sparas).
 */
export async function showResult(
	content: string,
	languageId: string
): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		content,
		language: languageId,
	});
	await vscode.window.showTextDocument(doc, {
		preview: true,
		viewColumn: vscode.ViewColumn.Beside,
	});
}
