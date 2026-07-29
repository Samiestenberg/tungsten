// FAS C5, del 1: refaktor-presets.
//
// En preset är INTE en egen funktion -- den är en genväg förbi inmatningsrutan
// i inline edit. Den går genom exakt samma runInlineEdit(): samma prompt,
// samma fence-strippning, samma omindentering, samma diff att godkänna.
//
// Det är hela poängen med att bygga den så. En preset som var en egen
// implementation hade kunnat glida isär från inline edit över tid, och det
// den skulle glida ifrån först är diff-godkännandet -- alltså precis den
// säkerhetsspärr som inte får försvinna.
//
// URVALET är fem ändringar som (a) är vanliga nog att man gör dem varje vecka
// och (b) är avgränsade nog att en 3B klarar dem på en markering. Att fylla
// menyn med tjugo poster hade gjort den till en katalog man bläddrar i i
// stället för en meny man slår upp.
import * as vscode from "vscode";
import { runInlineEdit } from "./inlineEdit.js";

interface Preset {
	readonly label: string;
	readonly detail: string;
	/**
	 * Instruktionen som skickas ordagrant. Skriven som en MENING till modellen,
	 * inte som ett kommandonamn -- "extract function" ensamt gav sämre svar än
	 * en mening som säger vad resultatet ska bli.
	 */
	readonly instruction: string;
}

const PRESETS: readonly Preset[] = [
	{
		label: "$(symbol-method) Extract function",
		detail: "Pull the selected code out into a well-named function and call it",
		instruction:
			"Extract this code into a separate, well-named function and call that " +
			"function where the code used to be. Keep the behaviour identical.",
	},
	{
		label: "$(symbol-parameter) Add types",
		detail: "Annotate parameters, returns and locals from how they are used",
		instruction:
			"Add explicit type annotations to parameters, return values and " +
			"declarations, inferred from how the values are used. Do not change " +
			"any runtime behaviour.",
	},
	{
		label: "$(shield) Add error handling",
		detail: "Handle the failures this code can actually have",
		instruction:
			"Add error handling for the failures this code can actually have. " +
			"Handle them where they can be handled and let the rest surface with " +
			"a useful message. Do not swallow errors silently.",
	},
	{
		label: "$(symbol-event) Extract to hook",
		detail: "Move the stateful logic into a custom React hook",
		instruction:
			"Move the stateful logic into a custom React hook named use<Something> " +
			"and call that hook from the component. Keep the rendered output " +
			"identical.",
	},
	{
		label: "$(arrow-swap) for-loop to map",
		detail: "Replace the imperative loop with map/filter/reduce",
		instruction:
			"Replace the imperative loop with map, filter or reduce, whichever " +
			"fits what the loop actually does. Keep the result identical.",
	},
];

export function registerRefactorPresets(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand("freya.refactor", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage("Freya: no open file.");
				return;
			}

			const picked = await vscode.window.showQuickPick(
				PRESETS.map((p) => ({
					label: p.label,
					detail: p.detail,
					instruction: p.instruction,
				})),
				{
					title: "Freya: refactor the selection",
					placeHolder: "Runs locally on the 3B model. You approve a diff before anything changes.",
					matchOnDetail: true,
				}
			);
			if (!picked) {
				return;
			}

			await runInlineEdit(picked.instruction);
		})
	);
}
