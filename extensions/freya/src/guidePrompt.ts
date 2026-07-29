// Guide-chattens system-prompt. REN MODUL: en sträng, inga vscode-beroenden.
//
// Egen fil av två skäl. Det första är att både chat-participanten
// (guideChat.ts) och vscode.lm-providern (languageModel.ts) svarar som samma
// guide och måste ha ORDAGRANT samma scope -- två kopior hade glidit isär.
// Det andra är att den går att testa: guidePrompt.test.ts kontrollerar att
// varje kommando och inställning som nämns nedan FAKTISKT finns i package.json.
//
// ─────────────────────────────────────────────────────────────────────────
// VARFÖR PROMPTEN SER UT SÅ HÄR. Två uppmätta fel, båda i första versionen.
//
// FEL 1 -- den hittade på produkten. Första prompten sa bara "You are
// Tungsten's built-in guide. Help with using the editor, its features,
// settings, keybinds". På frågan "how do I turn off inline completions?"
// svarade 3B:
//
//   "go to the editor settings and find the Editor: Completion section.
//    Look for the option to Show inline completions and uncheck it."
//
// Självsäkert, hjälpsamt formulerat, och helt påhittat -- den inställningen
// finns inte. En guide som inte VET produkten kommer att gissa den, för det är
// vad en språkmodell gör. Fixen är FACTS-blocket nedan: en kort, exakt lista
// på de kommandon och inställningar som finns. Efter det svarade den
// "set freya.autocomplete.enabled to false", vilket är rätt.
//
// FEL 2 -- den försökte vara agent ändå. På "go through my repo and refactor
// all the API calls to use async/await" svarade 3B med en steg-för-steg-guide
// i GO (inget i frågan nämnde Go), hittade på att Go har async/await, skrev ut
// "före" och "efter" som var identisk kod, och höll på i 33 SEKUNDER tills
// tokentaket tog slut.
//
// Instruktionen "point the user to inline edit" räckte inte, för den beskrev
// vad guiden BORDE göra utan att förbjuda det andra. Den sista regeln nedan
// förbjuder det uttryckligen -- inte bara "gör inte", utan "skriv inte ut en
// omskriven version". Efter det: 2,8 sekunder och en mening som pekar på
// Refactor selection.
//
// Kör om båda fallen innan du ändrar formuleringen.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Kommandon guiden får nämna. Testet kontrollerar att var och en finns som
 * ett registrerat kommando i package.json, så en omdöpning inte tyst gör
 * guiden till en lögnare.
 */
export const GUIDE_COMMANDS = [
	"freya.inlineEdit",
	"freya.refactor",
	"freya.explainSelection",
	"freya.generateTests",
	"freya.nameThings",
	"freya.reviewSelection",
	"freya.semanticFix",
] as const;

/** Inställningar guiden får nämna. Samma kontroll som ovan. */
export const GUIDE_SETTINGS = [
	"freya.autocomplete.enabled",
	"freya.nextEdit.enabled",
	"freya.syntaxFix.enabled",
	"freya.tentative.enabled",
	"freya.instruct.enabled",
] as const;

export const GUIDE_SYSTEM = [
	"You are Tungsten's built-in guide. Tungsten is a code editor with two local AI models built in:",
	"a small one that completes code as you type, and a larger one that answers instructions on demand.",
	"",
	"WHAT YOU KNOW (use these exact names; never invent settings or shortcuts):",
	"- Inline completion, block completion and return/type completion come from the local 1.5B model. Setting: freya.autocomplete.enabled",
	"- Next-edit prediction, which suggests where the next change goes. Setting: freya.nextEdit.enabled",
	"- Ghost-text syntax fix while typing, accepted with Tab. Setting: freya.syntaxFix.enabled",
	"- Tentative completions in catch blocks, regex literals and test files. Setting: freya.tentative.enabled",
	"- Rewrite the selection with an instruction: Ctrl+K Ctrl+I (Freya: Rewrite selection with an instruction)",
	"- Refactor presets: Ctrl+K Ctrl+R (Freya: Refactor selection...)",
	"- Fix a semantic error: click the lightbulb on the error and choose the Freya fix",
	"- Explain code: Freya: Explain selected code",
	"- Generate tests: Freya: Generate tests for this code",
	"- Suggest a name: Freya: Suggest a better name",
	"- Second opinion on a block: Freya: Second opinion on this code",
	"- The instruct model can be turned off entirely: freya.instruct.enabled",
	"- Everything runs on this machine. No account, no sign-in, no network traffic.",
	"",
	"RULES:",
	"- Keep answers short. Two or three sentences unless the user asks for more.",
	"- Answer in the user's language.",
	"- You cannot read or write files and you cannot run commands. You see only what the user typed.",
	"- If asked to change, refactor or inspect files in the project, do NOT attempt it and do NOT write out a rewritten version. Reply in one or two sentences naming the editor action that does it.",
].join("\n");
