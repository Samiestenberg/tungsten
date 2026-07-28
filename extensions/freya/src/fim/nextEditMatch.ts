// Var nästa ändring troligen ska ske. REN MODUL: strängar in, radnummer ut.
//
// IDÉN, och varför den fungerar med en 1.5B:
//
// En 1.5B kan inte resonera om vad du HÅLLER PÅ MED. Men den behöver den inte
// göra, för den vanligaste "nästa ändring" i verkligt arbete är inte ett nytt
// påhitt -- det är SAMMA ändring en gång till, någon annanstans. Du bytte
// `foo.bar` mot `foo.baz` på rad 12; rad 40 och rad 87 ser likadana ut och ska
// nästan säkert ändras likadant.
//
// Så den här modulen gissar inte VAD ändringen är. Den letar upp de andra
// ställena som såg ut som stället du nyss ändrade, och lämnar över till FIM
// att fylla i raden. Det är en fråga 1.5B:n faktiskt kan svara på: "givet
// koden runt omkring, hur ska den här raden se ut?"
//
// Att den ibland har fel är inbyggt i priset: förslaget visas, användaren
// hoppar dit eller ignorerar det.

/**
 * Raden reducerad till sina beståndsdelar. Blanktecken och skiljetecken
 * bort -- det är STRUKTUREN som ska jämföras, inte indenteringen.
 */
export function lineTokens(line: string): string[] {
	return line
		.split(/[^A-Za-z0-9_$]+/)
		.filter((t) => t.length > 0);
}

/**
 * Raden som en SEKVENS av symboler: identifierare och skiljetecken, i ordning.
 * Skiljetecknen är med för att det är de som bär strukturen -- `= x.y();` är
 * formen, och formen är det som gör två rader till samma sorts rad.
 */
export function lineSymbols(line: string): string[] {
	return line.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? [];
}

/** Tak på jämförelsens storlek. En minifierad rad ska inte kosta O(n²) på 40 kB. */
const MAX_SYMBOLS = 200;

/** Längsta gemensamma delsekvens. Klassisk DP, två rader i taget. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
	let prev = new Array<number>(b.length + 1).fill(0);
	let curr = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			curr[j] = a[i - 1] === b[j - 1]
				? prev[j - 1] + 1
				: Math.max(prev[j], curr[j - 1]);
		}
		[prev, curr] = [curr, prev];
		curr.fill(0);
	}
	return prev[b.length];
}

/**
 * Hur lika två rader är, 0..1.
 *
 * LÄNGSTA GEMENSAMMA DELSEKVENS över symbolerna, inte överlapp mellan
 * mängder. Skillnaden är inte akademisk -- den avgjorde måttet:
 *
 *   const name = user.getName();
 *   const age  = user.getAge();
 *
 * De två raderna är uppenbart samma sorts rad, men som MÄNGDER delar de bara
 * `const` och `user` av fyra identifierare vardera: Jaccard 0,33, alltså under
 * varje rimlig tröskel. Som SEKVENSER delar de `const = user . ( ) ;` av nio
 * symboler: 0,78. Måttet ska fånga att strukturen är densamma och att bara
 * namnen skiljer, för det är precis det fallet funktionen finns för.
 *
 * Ordningen räknas också, vilket är ett andra skäl: två rader med samma ord i
 * omkastad ordning är inte samma rad.
 */
export function lineSimilarity(a: string, b: string): number {
	const symA = lineSymbols(a).slice(0, MAX_SYMBOLS);
	const symB = lineSymbols(b).slice(0, MAX_SYMBOLS);
	if (symA.length === 0 || symB.length === 0) {
		return 0;
	}
	return (2 * lcsLength(symA, symB)) / (symA.length + symB.length);
}

/**
 * Tröskeln för "det här är samma sorts rad".
 *
 * 0,6 är valt för att vara STRÄNG. En låg tröskel ger förslag överallt, och
 * ett förslag som oftast har fel är värre än inget förslag: användaren slutar
 * titta på det.
 */
export const SIMILARITY_THRESHOLD = 0.6;

export interface EditSibling {
	line: number;
	similarity: number;
}

/**
 * Rader som liknar `pattern` men INTE redan ser ut som `replacement`.
 *
 * Andra villkoret är det viktiga: har raden redan ändrats är den inte nästa
 * ändring. Utan det hade vi föreslagit samma ändring om och om igen på rader
 * som redan var klara.
 *
 * Resultatet är sorterat: närmast EFTER `origin` först (det är dit blicken är
 * på väg), sedan resten.
 */
export function findEditSiblings(
	lines: readonly string[],
	pattern: string,
	replacement: string,
	origin: number
): EditSibling[] {
	const candidates: EditSibling[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (i === origin) {
			continue;
		}
		const line = lines[i];
		if (!line.trim()) {
			continue;
		}
		// Redan i målform? Då är den klar.
		if (line.trim() === replacement.trim()) {
			continue;
		}
		const similarity = lineSimilarity(line, pattern);
		if (similarity >= SIMILARITY_THRESHOLD) {
			candidates.push({ line: i, similarity });
		}
	}

	// Närmast nedåt först, sedan uppåt. Inom samma riktning: mest lik först.
	candidates.sort((a, b) => {
		const aBelow = a.line > origin;
		const bBelow = b.line > origin;
		if (aBelow !== bBelow) {
			return aBelow ? -1 : 1;
		}
		const aDist = Math.abs(a.line - origin);
		const bDist = Math.abs(b.line - origin);
		if (aDist !== bDist) {
			return aDist - bDist;
		}
		return b.similarity - a.similarity;
	});

	return candidates;
}

/**
 * Är den här ändringen värd att förutsäga vidare?
 *
 * Nej för: ren inskrivning (användaren skriver fortfarande), tomma rader,
 * och ändringar som bara är blanktecken. En förutsägelse mitt i ett ord är
 * bara brus.
 */
export function isMeaningfulEdit(before: string, after: string): boolean {
	if (!before.trim() || !after.trim()) {
		return false;
	}
	if (before.trim() === after.trim()) {
		return false;
	}
	// Minst ett riktigt token måste ha bytts ut. Ett tillagt tecken mitt i ett
	// namn är fortfarande någon som skriver.
	const beforeTokens = new Set(lineTokens(before));
	const afterTokens = lineTokens(after);
	const introduced = afterTokens.filter((t) => !beforeTokens.has(t));
	if (introduced.length === 0) {
		return false;
	}
	// Raden får inte ha blivit oigenkännlig -- då är det en ny rad, inte en
	// ändring som ska upprepas.
	return lineSimilarity(before, after) >= 0.3;
}
