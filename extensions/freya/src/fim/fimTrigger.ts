// Vad markören står i, och vad det betyder för FIM-anropet.
//
// REN MODUL: inga beroenden på vscode, ingen I/O. Allt här är strängar in och
// ett beslut ut, vilket är precis varför det går att testa -- och de här
// besluten är hela skillnaden mellan "nästa token" och "resten av
// funktionskroppen".
//
// Varför en klassificerare och inte en provider per beteende: alla beteenden
// är SAMMA FIM-anrop mot samma modell. Det enda som skiljer dem är
// tokenbudgeten och var vi stoppar. Flera providers hade betytt flera anrop
// per tangenttryck och flera förslag som slåss om samma yta.

export type FimKind = "line" | "block";

export interface FimPlan {
	kind: FimKind;
	/** n_predict. Latensen följer det här talet, inte modellstorleken. */
	maxTokens: number;
	/** Stoppsekvenser utöver Qwens FIM-tokens. */
	stop: string[];
	/** true = förslaget får spänna över flera rader. */
	multiline: boolean;
	/** Indenteringen som ett flerradigt förslag ska klippas mot. */
	baseIndent: string;
}

/**
 * Tak för ETT enradsförslag. Talet kommer ur mätning, inte magkänsla: 1.5B:n
 * genererar ~40 tokens/s på CPU, så 24 tokens är ~600 ms generering plus
 * prompt-eval. Högre tak gav 1-2,8 s och förslag som fortsatte förbi det man
 * ville ha.
 */
export const INLINE_TOKEN_CAP = 24;

/**
 * Tak för ett BLOCK. Fyra gånger radtaket, alltså ~2,5 s i värsta fall.
 *
 * Det är mycket för ett inline-förslag. Det är ändå rätt: ett block begärs
 * bara när markören står på en TOM rad direkt efter en öppnad kropp, vilket är
 * ett ögonblick då användaren just tryckt Enter och tänker -- inte mitt i ett
 * ord. Väntan hamnar i en paus som redan fanns.
 */
export const BLOCK_TOKEN_CAP = 96;

/** Språk där ett block öppnas med { och stängs med }. */
const BRACE_LANGUAGES = new Set([
	"typescript", "typescriptreact", "javascript", "javascriptreact",
	"c", "cpp", "csharp", "java", "go", "rust", "php", "scala", "kotlin",
	"swift", "dart", "groovy", "objective-c", "objective-cpp",
]);

/** Språk där ett block öppnas med : och hålls ihop av indentering. */
const COLON_LANGUAGES = new Set(["python", "coffeescript", "nim"]);

/** Nyckelord som öppnar en kropp utan att raden slutar på { eller :. */
const BARE_BLOCK_OPENERS = /\b(else|do|try|finally)\s*$/;

/** Raden markören står på, fram till markören. */
export function currentLinePrefix(prefix: string): string {
	const nl = prefix.lastIndexOf("\n");
	return nl < 0 ? prefix : prefix.slice(nl + 1);
}

/** Indenteringen (blanktecknen) på en rad. */
export function indentOf(line: string): string {
	return /^[ \t]*/.exec(line)![0];
}

/** Sista raden FÖRE markörens rad som inte är tom. */
export function previousNonEmptyLine(prefix: string): string {
	const lines = prefix.split("\n");
	// Sista elementet är markörens egen (ofullständiga) rad.
	for (let i = lines.length - 2; i >= 0; i--) {
		if (lines[i].trim()) {
			return lines[i];
		}
	}
	return "";
}

/** Öppnar den här raden en kropp? */
export function opensBlock(line: string, languageId: string): boolean {
	// En kommentar öppnar ingenting: "// gör så här {" är inte ett block.
	const code = line
		.replace(/\/\/.*$/, "")
		.replace(/#.*$/, "")
		.trimEnd();
	if (!code) {
		return false;
	}
	if (BRACE_LANGUAGES.has(languageId)) {
		return code.endsWith("{") || BARE_BLOCK_OPENERS.test(code);
	}
	if (COLON_LANGUAGES.has(languageId)) {
		return code.endsWith(":");
	}
	// Okänt språk: gissa inte på block. Ett felaktigt blockförslag kostar 2,5 s
	// och ger något som inte hör hemma i filen.
	return false;
}

/**
 * Vad ska det här FIM-anropet vara?
 */
export function classifyFimTrigger(
	prefix: string,
	languageId: string,
	configuredMaxTokens: number
): FimPlan {
	const linePrefix = currentLinePrefix(prefix);
	const baseIndent = indentOf(linePrefix);

	// BLOCK. Markören står på en tom rad direkt efter en öppnad kropp. Det är
	// ögonblicket då "resten av funktionskroppen" är det man vill ha, inte
	// nästa token.
	if (!linePrefix.trim()) {
		const opener = previousNonEmptyLine(prefix);
		if (opensBlock(opener, languageId)) {
			return {
				kind: "block",
				maxTokens: BLOCK_TOKEN_CAP,
				// INGET radstopp: hela poängen är flera rader. Suffixet talar om
				// för modellen var kroppen slutar.
				stop: [],
				multiline: true,
				// Blocket klipps mot ÖPPNARENS indentering, inte markörens:
				// kroppen ligger en nivå in, och det är när vi kommer tillbaka
				// ut till öppnarens nivå som blocket är slut.
				baseIndent: indentOf(opener),
			};
		}
	}

	// VANLIG RAD. Enheten för ett inline-förslag är EN rad; utan radstoppet
	// fortsatte 1.5B:n förbi kompletteringen och hittade på fler metoder
	// (uppmätt 2264 ms och ett förslag ingen ville ha).
	return {
		kind: "line",
		maxTokens: Math.min(configuredMaxTokens, INLINE_TOKEN_CAP),
		stop: ["\n"],
		multiline: false,
		baseIndent,
	};
}

/**
 * Klipper ett flerradigt blockförslag där blocket tar slut.
 *
 * Modellen får inget radstopp i block-läget, så den fortsätter gärna FÖRBI den
 * stängande klammern och skriver nästa funktion också. Regeln: så snart en
 * icke-tom rad har indentering på ÖPPNARENS nivå eller mindre, har vi lämnat
 * blocket och resten kastas.
 *
 * Den stängande raden själv (}, ), ]) tas med -- den hör till blocket, och
 * utan den blir förslaget osymmetriskt.
 *
 * `openerIndent` är indenteringen på raden som öppnade kroppen.
 */
export function trimToBlock(completion: string, openerIndent: string): string {
	const lines = completion.split("\n");
	const kept: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			kept.push(line);
			continue;
		}
		// Första raden börjar där markören står och har därför ingen egen
		// indentering i modellens svar -- den hör alltid till blocket.
		if (i > 0 && indentOf(line).length <= openerIndent.length) {
			if (/^\s*[)}\]]/.test(line)) {
				kept.push(line);
			}
			break;
		}
		kept.push(line);
	}

	// Efterföljande tomrader är brus.
	while (kept.length && !kept[kept.length - 1].trim()) {
		kept.pop();
	}
	return kept.join("\n");
}
