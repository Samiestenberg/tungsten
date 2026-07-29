// Är det här ett SYNTAKTISKT fel? REN MODUL: meddelande in, ja/nej ut.
//
// TVÅSTEGSFELSÖKNINGEN, steg 1 av 2. Gränsen den här filen drar är hela
// poängen med uppdelningen:
//
//   SYNTAKTISKT fel (saknad }, ), ; eller ,) -- parsern vet exakt vad som
//   fattas, det finns inget att RESONERA om, och luckan är två tecken lång.
//   Det är ett FIM-problem: prefix före markören, suffix efter, fyll luckan.
//   1.5B klarar det på ~200 ms, alltså medan användaren skriver.
//
//   SEMANTISKT fel ("Property x does not exist on type Y") -- kräver att
//   någon förstår typerna, historiken och avsikten. Det går till 3B-lanen,
//   on-demand, och bara när användaren klickar på felet (semanticFix.ts).
//
// Skickar vi ett syntaxfel till 3B får användaren vänta två sekunder på något
// parsern redan visste. Skickar vi ett semantiskt fel till 1.5B får hen ett
// självsäkert nonsenssvar. Därför den här filen.

/**
 * Ord som betyder "parsern kom av sig", på de språk vi ser i praktiken.
 * TypeScript, ESLint, Python, Rust och C# formulerar sig olika men landar
 * alla i den här familjen.
 */
const SYNTAX_PHRASES = [
	/\bexpected\b/i,
	/\bunexpected\b/i,
	/\bmissing\b/i,
	/\bunterminated\b/i,
	/\bunclosed\b/i,
	/\bunmatched\b/i,
	/\binvalid syntax\b/i,
	/\bparse error\b/i,
	/\bparsing error\b/i,
	/\bdeclaration or statement expected\b/i,
];

/**
 * TypeScript-koder i 1xxx-serien är parserfel. 2xxx är typkontrollen, alltså
 * semantik. Den gränsen är exakt den vi vill dra, och den är dokumenterad --
 * mycket bättre än att gissa på meddelandetexten när koden finns.
 */
function isSyntaxCode(code: string | number | undefined): boolean | undefined {
	if (code === undefined) {
		return undefined;
	}
	const numeric = typeof code === "number" ? code : Number(String(code).replace(/^TS/i, ""));
	if (!Number.isFinite(numeric)) {
		return undefined;
	}
	return numeric >= 1000 && numeric < 2000;
}

/**
 * Meddelanden som ser syntaktiska ut men INTE är det. Sorterat efter hur ofta
 * de dök upp: `Property 'x' does not exist` innehåller inget av orden ovan,
 * men `Type 'X' is not assignable` och vänner gör det ibland.
 */
const SEMANTIC_DESPITE_PHRASING = [
	/\bdoes not exist on type\b/i,
	/\bis not assignable to\b/i,
	/\bhas no exported member\b/i,
	/\bcannot find name\b/i,
	/\bcannot find module\b/i,
	/\bimplicitly has an? .* type\b/i,
	/\bis declared but\b/i,
	/\bis possibly\b/i,
	/\boverload\b/i,
];

/**
 * true = skicka till 1.5B som FIM. false = det här är inte vårt fall.
 *
 * `code` vinner över texten när den finns: den är entydig, texten är en
 * gissning. Utan kod faller vi tillbaka på frasmönstren, med de semantiska
 * undantagen först.
 */
export function isSyntaxDiagnostic(
	message: string,
	code?: string | number
): boolean {
	const byCode = isSyntaxCode(code);
	if (byCode !== undefined) {
		return byCode;
	}
	if (SEMANTIC_DESPITE_PHRASING.some((re) => re.test(message))) {
		return false;
	}
	return SYNTAX_PHRASES.some((re) => re.test(message));
}

/**
 * Det modellen gav oss, nedskuret till något som får klistras in mitt i en rad.
 *
 * En syntaxlucka är två tecken, inte två rader. Får modellen fortsätta
 * skriver den gärna resten av funktionen -- och då är förslaget inte längre
 * "det som saknas för att det ska parsa" utan en omskrivning ingen bad om.
 */
export function sanitizeGap(raw: string, maxChars = 40): string {
	// Bara första raden. Ett flerradigt "fyll i det som fattas" är inte en fix,
	// det är en ny kropp.
	const firstLine = raw.split("\n")[0];
	// Inledande blanktecken hör inte hemma i en lucka mitt i en rad.
	const trimmed = firstLine.replace(/^[ \t]+/, "").trimEnd();
	return trimmed.length > maxChars ? "" : trimmed;
}

/**
 * Är gissningen värd att visa?
 *
 * Nej för tomma svar, och nej för svar som bara är blanktecken. En lucka som
 * inte innehåller något är inte en fix -- den ser bara ut som om Freya
 * föreslog något.
 */
export function isUsefulGap(gap: string): boolean {
	return gap.trim().length > 0;
}
