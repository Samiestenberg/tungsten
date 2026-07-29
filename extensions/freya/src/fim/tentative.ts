// TENTATIVA FIM-FÖRSLAG. Läs det här innan du lägger till fler.
//
// De tre lägena i den här filen är GRÄNSFALL. De skiljer sig från allt annat i
// FIM-lanen på en punkt, och den punkten är principiell:
//
//   Resten av 1.5B-lanen ber modellen FORTSÄTTA det som redan står där. Här
//   ber vi den gissa en gnutta AVSIKT -- vad ett felhanteringsblock borde göra,
//   vad ett reguljärt uttryck ska matcha, vilka fall ett test ska ha.
//
// Det är precis den sorts fråga som egentligen hör hemma i instruct-lanen. De
// ligger ändå kvar här, av ett skäl: i de tre snäva lägena nedan står svaret
// nästan i koden runt omkring, och 1.5B träffar tillräckligt ofta för att
// vara värd ett förslag som kostar Esc att avvisa. "Tillräckligt ofta" är inte
// "alltid" -- därför:
//
//   * Egen inställning (freya.tentative.enabled) så de går att stänga av utan
//     att röra resten av kompletteringen.
//   * Lägre tokenbudget än motsvarande säkra läge. En gissning ska inte kosta
//     lika mycket väntan som ett säkert svar.
//   * ALDRIG auto-apply. De visas som vanlig ghost-text, vilket är VS Codes
//     lätt-att-avslå-affordans: Esc avvisar, Tab accepterar, ingenting händer
//     av sig självt.
//
// SKELETT, INTE INNEHÅLL. Test-läget nedan får ge strukturen -- it(), expect()
// -- och ingenting annat. Vilka edge case ett test SKA täcka är ett omdöme,
// och omdöme är 3B-lanens jobb (generateTests.ts). Blandar man ihop det får
// man testfall som ser rimliga ut och inte testar något.
//
// REN MODUL: strängar in, en plan ut. Inga beroenden på vscode.

import { previousNonEmptyLine, type FimPlan } from "./fimTrigger.js";

export type TentativeKind = "error-handler" | "regex" | "test-skeleton";

export interface TentativePlan extends FimPlan {
	/** Vilket gränsfall det var. Bara för loggar och för att kunna mäta träff. */
	tentativeKind: TentativeKind;
}

/** Tak för en gissning. Medvetet lägre än blockläget (96). */
const TENTATIVE_BLOCK_CAP = 64;

/** Tak för ett tentativt uttryck (regex, callback-huvud). */
const TENTATIVE_EXPRESSION_CAP = 28;

/** Raden markören står på, fram till markören. */
function currentLine(prefix: string): string {
	const nl = prefix.lastIndexOf("\n");
	return nl < 0 ? prefix : prefix.slice(nl + 1);
}

function indentOf(line: string): string {
	return /^[ \t]*/.exec(line)![0];
}

/** Är det här en testfil? Namnet är den enda signal vi har utan att parsa. */
export function isTestFile(fileName: string): boolean {
	const normalized = fileName.replace(/\\/g, "/");
	return (
		/\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized) ||
		/_test\.(py|go|rb)$/i.test(normalized) ||
		/(^|\/)test_[^/]+\.py$/i.test(normalized) ||
		/(^|\/)(__tests__|__test__|spec|tests?)\//i.test(normalized)
	);
}

/** `catch (e) {` eller pythons `except ...:` -- en felhanterare öppnas. */
function opensErrorHandler(line: string): boolean {
	const code = line.replace(/\/\/.*$/, "").replace(/#.*$/, "").trimEnd();
	return (
		/\bcatch\s*\([^)]*\)\s*\{$/.test(code) ||
		/\bcatch\s*\{$/.test(code) ||
		/\bexcept\b[^:]*:$/.test(code) ||
		/\brescue\b/.test(code)
	);
}

/** `describe(...)  {` / `suite(...) {` -- ett testblock öppnas. */
function opensTestBlock(line: string): boolean {
	return /\b(describe|suite|context)\s*\(.*\{\s*$/.test(line.trimEnd());
}

/**
 * Språk där /.../ är en regex-LITERAL. I python skrivs mönstret som en sträng
 * och ett snedstreck är division, så där finns inget läge att känna igen.
 */
const REGEX_LITERAL_LANGUAGES = new Set([
	"typescript", "typescriptreact", "javascript", "javascriptreact", "ruby", "perl",
]);

/**
 * Står markören INNE i en regex-literal som just öppnats?
 *
 * Bara direkt efter ett anrop som tar ett mönster. `a / b / c` i vanlig
 * aritmetik ska inte se ut som en regex, och kravet på metodnamnet är det som
 * hindrar det.
 */
function inFreshRegex(linePrefix: string, languageId: string): boolean {
	if (!REGEX_LITERAL_LANGUAGES.has(languageId)) {
		return false;
	}
	return /\.(replace|replaceAll|match|matchAll|search|split|test|exec)\(\s*\/[^/\n]*$/.test(
		linePrefix
	);
}

/** `.catch(` med markören direkt efter -- ett felhanterings-callback ska in. */
function afterCatchCall(linePrefix: string): boolean {
	return /\.catch\(\s*$/.test(linePrefix);
}

/**
 * Ett tentativt läge, eller undefined när inget av de tre gäller.
 *
 * Anropas FÖRE classifyFimTrigger: de tre lägena här är snävare än de allmänna
 * och ska vinna när de träffar. Returneras undefined faller providern tillbaka
 * på det vanliga beteendet.
 */
export function classifyTentative(
	prefix: string,
	languageId: string,
	fileName: string
): TentativePlan | undefined {
	const linePrefix = currentLine(prefix);
	const baseIndent = indentOf(linePrefix);

	// 1. REGEX/FORMATTER. Markören står inne i ett nyöppnat mönster.
	//    Enradigt och kort: ett mönster är en rad, aldrig en kropp.
	if (inFreshRegex(linePrefix, languageId)) {
		return {
			kind: "line",
			tentativeKind: "regex",
			maxTokens: TENTATIVE_EXPRESSION_CAP,
			stop: ["\n"],
			multiline: false,
			baseIndent,
		};
	}

	// 2. FELHANTERARE efter .catch( -- callbackens huvud, på en rad.
	if (afterCatchCall(linePrefix)) {
		return {
			kind: "line",
			tentativeKind: "error-handler",
			maxTokens: TENTATIVE_EXPRESSION_CAP,
			stop: ["\n"],
			multiline: false,
			baseIndent,
		};
	}

	// Resten kräver att markören står på en tom rad i en nyöppnad kropp.
	if (linePrefix.trim()) {
		return undefined;
	}
	const opener = previousNonEmptyLine(prefix);

	// 3. FELHANTERARE efter catch (e) { eller except ...:
	if (opensErrorHandler(opener)) {
		return {
			kind: "block",
			tentativeKind: "error-handler",
			maxTokens: TENTATIVE_BLOCK_CAP,
			stop: [],
			multiline: true,
			baseIndent: indentOf(opener),
		};
	}

	// 4. TEST-SKELETT i en testfil, direkt i ett describe/suite-block.
	//    STRUKTUREN, inte innehållet -- se filhuvudet.
	if (isTestFile(fileName) && opensTestBlock(opener)) {
		return {
			kind: "block",
			tentativeKind: "test-skeleton",
			maxTokens: TENTATIVE_BLOCK_CAP,
			stop: [],
			multiline: true,
			baseIndent: indentOf(opener),
		};
	}

	return undefined;
}

/**
 * Klipper ett regex-förslag där MÖNSTRET tar slut.
 *
 * Behövs för att modellen inte stannar där. Uppmätt mot 1.5B:n, prefix
 * `title.toLowerCase().replace(/` med suffix `, "-");`:
 *
 *   fick:  ` /g, "-").replace(/[^a-z0-9-]/g, "");`
 *   ville: ` /g`
 *
 * Mönstret var rätt -- den fortsatte bara förbi det och skrev om resten av
 * raden som redan fanns i suffixet. Vi behåller till och med det avslutande
 * snedstrecket plus flaggorna och kastar resten.
 *
 * Snedstreck som är escapade (\/) eller står i en teckenklass ([/]) räknas
 * inte som slutet -- de hör till mönstret.
 */
export function trimRegexSuggestion(raw: string): string {
	const text = raw.split("\n")[0];
	let inClass = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") {
			i++; // hoppa över det escapade tecknet
			continue;
		}
		if (ch === "[") {
			inClass = true;
			continue;
		}
		if (ch === "]") {
			inClass = false;
			continue;
		}
		if (ch === "/" && !inClass) {
			// Slutet på mönstret. Ta med flaggorna som följer direkt efter.
			const flags = /^[gimsuyvd]*/.exec(text.slice(i + 1))![0];
			return text.slice(0, i + 1 + flags.length);
		}
	}

	// Inget avslutande snedstreck inom budgeten: mönstret är ofullständigt och
	// vi ger tillbaka det som finns. Användaren skriver klart det själv.
	return text;
}
