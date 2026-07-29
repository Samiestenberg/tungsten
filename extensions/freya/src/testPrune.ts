// Städning av genererade testfiler. REN MODUL, inga vscode-beroenden.
//
// VARFÖR DEN FINNS -- uppmätt, inte befarat. 3B ombeds skriva tester för
// clampToLines() och börjar bra: sex vettiga fall (normalfallet, tom sträng,
// maxChars == längden, maxChars < längden, maxChars == 0). Sedan fastnar den:
//
//   it("...with a newline and a space", ...)
//   it("...with a newline and a space at the end", ...)
//   it("...with a newline and a space at the beginning and end", ...)
//   it("...with a newline and a space at the beginning and end and a
//       trailing space and a newline and a space", ...)
//
// Varje namn är föregående namn plus ett led. Den fortsatte tills tokentaket
// tog slut -- mitt i en sträng, så filen slutade i ett trasigt uttryck.
//
// Det är en känd degenerering hos små modeller och den går inte att
// instruera bort. Den går däremot att KLIPPA BORT, och det är två separata
// problem som båda måste lösas:
//
//   1. Upprepningen. Så snart ett testnamn är nästan identiskt med ett
//      tidigare har modellen fastnat, och resten är brus.
//   2. Avhuggningen. Ett svar som tar slut mitt i ett uttryck ska aldrig visas
//      -- filen måste vara balanserad när vi lämnar över den.
//
// Likhetsmåttet är samma som next-edit-lanen använder för att se om två rader
// är samma sorts rad. Det passar av samma skäl: det är SEKVENSEN som är lik,
// inte ordmängden.
import { lineSimilarity } from "./fim/nextEditMatch.js";

/**
 * Hur lika två testnamn får vara innan paret räknas som en upprepning.
 *
 * 0,82: de degenererade namnen ligger på 0,85-0,95 av varandra, medan riktigt
 * olika fall ("handles empty text" mot "cuts at the last newline") ligger under
 * 0,4.
 */
const REPEAT_THRESHOLD = 0.82;

/**
 * Hur många upprepningar I RAD som krävs innan vi klipper.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VARFÖR DET INTE RÄCKER MED ETT PAR -- uppmätt vid modellbytet till Granite.
 *
 * Den första versionen klippte vid FÖRSTA namnet som liknade ett tidigare.
 * Det fungerade mot Qwens degenerering, men åt ett fullt legitimt test ur
 * Granites svar. Granite namnger så här:
 *
 *   "returns the text if it's less than or equal to the max length"
 *   "returns the first line of the text if it's longer than the max length"
 *   "returns the first line of the text if it's longer than half the max length"
 *
 * De två sista ligger runt 0,9 av varandra -- alltså inom samma spann som
 * Qwens degenererade namn -- men de testar OLIKA grenar (den andra träffar
 * `cut > maxChars / 2`). Likheten mellan två namn kan alltså inte skilja
 * fallen åt; det är samma tal.
 *
 * Det som SKILJER dem är mönstret. Ett enstaka likt par är normalt: tester av
 * samma funktion heter naturligt likt. En degenerering är en LÖPANDE serie där
 * varje namn är föregående plus ett led -- Qwen producerade femton i rad.
 *
 * Så vi klipper först när tre i följd är nästan identiska, och klipper då vid
 * seriens BÖRJAN. Mot Qwens svar ligger de sex första fallen kvar och serien
 * kapas; mot Granites svar utlöses ingenting.
 * ─────────────────────────────────────────────────────────────────────────
 */
const REPEAT_RUN_TO_CUT = 3;

/** Rader som inleder ett testfall, på de ramverk vi genererar för. */
const TEST_START =
	/^\s*(?:(?:it|test|specify)\s*[(.]|def\s+test_|func\s+Test[A-Z]|#\[test\])/;

/** Namnet i ett testfall, dvs. första strängliteralen på raden. */
export function testName(line: string): string | undefined {
	const m = /["'`]([^"'`]{3,})["'`]/.exec(line);
	if (m) {
		return m[1];
	}
	// def test_something(): / func TestSomething(t *testing.T)
	const ident = /(?:def\s+test_|func\s+Test)([A-Za-z0-9_]+)/.exec(line);
	return ident ? ident[1] : undefined;
}

/**
 * Öppnade klamrar/parenteser som ännu inte stängts, som en STACK.
 *
 * Stacken och inte bara ett djup: med stacken vet vi exakt vilka tecken som
 * ska till för att stänga, så ett avklippt svar kan balanseras i stället för
 * gissas ihop.
 *
 * Sträng- och kommentarmedveten. En klammer i "{" eller efter // räknas inte.
 */
export function openStack(code: string): string[] {
	const stack: string[] = [];
	let quote: string | undefined;
	let lineComment = false;
	let blockComment = false;

	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		const next = code[i + 1];

		if (lineComment) {
			if (ch === "\n") { lineComment = false; }
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") { blockComment = false; i++; }
			continue;
		}
		if (quote) {
			if (ch === "\\") { i++; continue; }
			if (ch === quote) { quote = undefined; }
			continue;
		}
		if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
		if (ch === "#") { lineComment = true; continue; }
		if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }

		if (ch === "(" || ch === "{" || ch === "[") {
			stack.push(ch);
		} else if (ch === ")" || ch === "}" || ch === "]") {
			stack.pop();
		}
	}
	return stack;
}

/** Tecknen som stänger en öppen stack, i rätt ordning. */
function closersFor(stack: readonly string[]): string {
	const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
	return stack
		.slice()
		.reverse()
		.map((ch) => pairs[ch] ?? "")
		.join("");
}

/**
 * Klipper bort degenererade upprepningar och balanserar det som blir kvar.
 *
 * Returnerar koden oförändrad när inget behövde göras -- det normala fallet.
 */
export function pruneGeneratedTests(code: string): string {
	const lines = code.split("\n");

	// 1. Hitta en LÖPANDE SERIE av nästan identiska testnamn. Se
	//    REPEAT_RUN_TO_CUT: ett enstaka likt par är normalt, en serie är
	//    degenerering.
	const seen: string[] = [];
	/** Radindex där den pågående serien av upprepningar började. */
	let runStart = -1;
	let runLength = 0;
	let cutAt = -1;

	for (let i = 0; i < lines.length; i++) {
		if (!TEST_START.test(lines[i])) {
			continue;
		}
		const name = testName(lines[i]);
		if (!name) {
			continue;
		}

		const isRepeat = seen.some((prev) => lineSimilarity(prev, name) >= REPEAT_THRESHOLD);
		if (isRepeat) {
			if (runLength === 0) {
				runStart = i;
			}
			runLength++;
			if (runLength >= REPEAT_RUN_TO_CUT) {
				cutAt = runStart;
				break;
			}
		} else {
			// Serien bröts av ett genuint nytt fall. Börja om räkningen -- annars
			// hade tre spridda liknande namn genom hela filen räknats som en serie.
			runLength = 0;
			runStart = -1;
		}
		seen.push(name);
	}

	// 2. Är svaret dessutom avhugget? Då måste det klippas även utan upprepning.
	const truncated = openStack(code).length > 0;
	if (cutAt < 0 && !truncated) {
		return code;
	}

	if (cutAt < 0) {
		// Avhugget men inte upprepat: klipp vid sista testfallets början, så att
		// vi inte lämnar ett halvskrivet test kvar.
		//
		// ─────────────────────────────────────────────────────────────────
		// MEN FÖRST: ÄR DET SISTA TESTET ENS TRASIGT?
		//
		// openStack() mäter hela filen, och en genererad testfil är nästan
		// alltid inbäddad i ett describe(...). Tar tokentaket slut EFTER ett
		// avslutat it(...) men FÖRE describe-blockets `});` är hela filen
		// obalanserad trots att varje testfall i den är helt:
		//
		//   describe("clampToLines", () => {
		//     it("a", () => { ... });
		//     it("b", () => { ... });      <- komplett
		//   <- här tog tokentaket slut
		//
		// Den gamla koden klippte då vid `it("b"`, alltså ETT FULLT GILTIGT
		// TEST, och balanserade resten. Ett svar med två användbara fall gav
		// användaren ett. Det är precis den sortens tyst förlust den här filen
		// finns för att undvika.
		//
		// Så: klipp bara om svansen FRÅN sista testets början faktiskt är
		// obalanserad i sig. Är den hel behöver filen bara stängas, och det
		// gör balance() nedan.
		// ─────────────────────────────────────────────────────────────────
		let lastStart = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (TEST_START.test(lines[i])) {
				lastStart = i;
				break;
			}
		}
		if (lastStart < 0) {
			// Inga testfall alls att klippa vid. Balansera det som finns.
			return balance(code);
		}
		const tail = lines.slice(lastStart).join("\n");
		if (openStack(tail).length === 0) {
			// Sista testet är komplett -- bara omslutande block som saknar sin
			// stängning. Behåll allt.
			return balance(code);
		}
		cutAt = lastStart;
	}

	const kept = lines.slice(0, cutAt).join("\n").replace(/\s+$/, "");
	return balance(kept);
}

/** Lägger till de stängande tecknen som saknas, med rimlig indentering. */
function balance(code: string): string {
	const stack = openStack(code);
	if (stack.length === 0) {
		return code.replace(/\s+$/, "") + "\n";
	}
	const closers = closersFor(stack);
	// describe(...) stängs som "});" -- klamrarna först, sedan semikolon om
	// det yttersta som stängs är ett anrop.
	const semicolon = stack[0] === "(" ? ";" : "";
	return `${code.replace(/\s+$/, "")}\n${closers}${semicolon}\n`;
}
