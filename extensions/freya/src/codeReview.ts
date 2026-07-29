// FAS C5, del 3: code-review-mini.
//
// Markera ett block, ställ EN av två frågor, få PROSA tillbaka. Aldrig kod.
//
// Att svaret är prosa och inte en patch är det som gör funktionen ärlig. En
// 3B som ombeds "hitta buggen och fixa den" producerar en patch oavsett om
// den hittade något -- den har inget sätt att svara "det ser bra ut" i
// patchform. Ber man om prosa kan den säga det, och då är svaret värt att
// läsa. De två frågorna är dessutom SMALA med flit: en öppen "granska det
// här" ger en uppräkning av allmänna råd som gäller all kod.
//
// FALSKA POSITIVA -- uppmätt, och därför är prompterna nedan formulerade som
// de är. Första versionen sa bara "If you find nothing wrong, say so plainly.
// Do not invent problems." Mot ren, korrekt kod svarade 3B ändå:
//
//   "Yes, there is a bug ... The current implementation uses `a + b` as the
//    function, which is incorrect. The correct implementation should be
//    `a + b` ..."
//
// Alltså en påhittad bugg, med sig själv som lösning. Modellen hade fått en
// fråga som förutsatte ett fynd och levererade ett.
//
// Det som fixade det var att göra NEJ-svaret till ett förstahandsalternativ i
// stället för ett undantag: säga att de flesta fragment inte har någon bugg,
// och kräva att svaret börjar med "Bug:" eller "Nothing wrong:". Efter det
// svarade den rätt på båda -- "Nothing wrong:" på den rena koden och en korrekt
// off-by-one på den trasiga. Ändra inte formuleringen utan att köra om båda.
//
// Svaret öppnas som markdown bredvid koden. En notifiering hade klippt det,
// och en panel hade varit en yta till att underhålla.
import * as vscode from "vscode";
import {
  clampToLines,
  instructAvailable,
  instructOneShot,
  INSTRUCT_MISSING,
} from "./instructModel.js";
import { showResult } from "./preview.js";

/** Taket på blocket som granskas. Ett helt filträd är ingen granskning. */
const MAX_CODE_CHARS = 4000;

interface ReviewQuestion {
	readonly label: string;
	readonly detail: string;
	readonly system: string;
	readonly ask: string;
}

const QUESTIONS: readonly ReviewQuestion[] = [
	{
		label: "$(bug) Is there a bug here?",
		detail: "Looks for what actually breaks, not for style",
		// FORMULERINGEN NEDAN ÄR MÄTT FRAM, inte skriven på känsla. Se
		// filhuvudets not om falska positiva.
		system: [
			"You look for bugs in a fragment of code.",
			"Most code you are shown has NO bug. \"I found nothing wrong\" is a correct, " +
				"expected and useful answer -- give it whenever it is true.",
			"Start your reply with either \"Bug:\" or \"Nothing wrong:\" and then one short paragraph.",
			"For \"Bug:\", name the concrete problem, the input that triggers it, and what goes wrong.",
			"Never invent a problem to have something to say. Never output a patch or a rewritten version.",
			"Ignore style, naming and formatting -- only correctness matters here.",
		].join("\n"),
		ask: "Is there a bug in this code?",
	},
	{
		label: "$(law) Is this idiomatic?",
		detail: "Whether it reads the way this language is normally written",
		system: [
			"You judge whether a fragment of code is written the way its language is normally written.",
			"Most code you are shown reads normally. \"This reads normally\" is a correct, " +
				"expected and useful answer -- give it whenever it is true.",
			"Start your reply with either \"Unusual:\" or \"Reads normally:\" and then one short paragraph.",
			"For \"Unusual:\", point at the specific place and say what the ordinary form is.",
			"Never invent an objection to have something to say. Never output a patch or a rewritten version.",
			"Ignore correctness here -- only how it reads matters.",
		].join("\n"),
		ask: "Is this idiomatic for this language?",
	},
];

export function registerCodeReview(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand("freya.reviewSelection", async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage("Freya: no open file.");
				return;
			}

			const range = editor.selection.isEmpty
				? editor.document.lineAt(editor.selection.active.line).range
				: new vscode.Range(editor.selection.start, editor.selection.end);
			const code = editor.document.getText(range).trim();

			if (!code) {
				vscode.window.showInformationMessage(
					"Freya: select the block you want a second opinion on."
				);
				return;
			}

			if (!instructAvailable()) {
				vscode.window.showWarningMessage(`Freya: ${INSTRUCT_MISSING}`);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				QUESTIONS.map((q) => ({ label: q.label, detail: q.detail, q })),
				{
					title: "Freya: second opinion on the selection",
					placeHolder: "Runs locally on the 3B model. You get prose back, not a patch.",
				}
			);
			if (!picked) {
				return;
			}

			const answer = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Freya is reading the selection...",
					cancellable: true,
				},
				async (_progress, token) => {
					const ac = new AbortController();
					const sub = token.onCancellationRequested(() => ac.abort());
					try {
						return await instructOneShot({
							system: picked.q.system,
							user: [
								`Language: ${editor.document.languageId}`,
								"",
								clampToLines(code, MAX_CODE_CHARS),
								"",
								picked.q.ask,
							].join("\n"),
							maxTokens: 400,
							signal: ac.signal,
						});
					} catch {
						return undefined;
					} finally {
						sub.dispose();
					}
				}
			);

			if (!answer?.trim()) {
				vscode.window.showWarningMessage("Freya: no answer this time.");
				return;
			}

			const where = `${vscode.workspace.asRelativePath(editor.document.uri)}:${range.start.line + 1}`;
			await showResult(
				[
					`# Freya: ${picked.q.ask}`,
					"",
					`\`${where}\` · answered locally by the 3B model · read it as a second opinion, not a verdict`,
					"",
					answer.trim(),
					"",
				].join("\n"),
				"markdown"
			);
		})
	);
}
