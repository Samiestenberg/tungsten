// Vilket testramverk projektet FAKTISKT använder. REN MODUL, inga vscode-beroenden.
//
// Varför detektering och inte en inställning: ett genererat test som använder
// fel ramverk är värdelöst på ett särskilt irriterande sätt -- det ser rätt ut,
// det körs inte, och felet syns först när man kör suiten. Repot vet redan
// svaret (det står i package.json), så vi frågar repot i stället för
// användaren.
//
// Ordningen i PACKAGE_JSON_FRAMEWORKS är prioritetsordning. Ett projekt kan ha
// både jest och mocha i trädet (en transitiv beroendekedja räcker), så vi
// letar i devDependencies/dependencies -- inte i node_modules -- och tar det
// första som matchar.

export interface TestFramework {
	/** Visas för användaren och går in i prompten. */
	readonly name: string;
	/**
	 * En rad som visar hur man importerar. Går in i prompten som EXEMPEL, inte
	 * som en regel -- 3B följer ett exempel bättre än en beskrivning.
	 */
	readonly importLine: string;
	/** Ändelse för testfilen, utan punkt. */
	readonly suffix: string;
	/** Språket testfilen skrivs i (för syntaxfärgning i förhandsvisningen). */
	readonly languageId: string;
}

const VITEST: TestFramework = {
	name: "Vitest",
	importLine: 'import { describe, it, expect } from "vitest";',
	suffix: "test.ts",
	languageId: "typescript",
};

const JEST: TestFramework = {
	name: "Jest",
	importLine: "// jest globals: describe, it, expect",
	suffix: "test.ts",
	languageId: "typescript",
};

const MOCHA_TDD: TestFramework = {
	name: "Mocha (tdd: suite/test)",
	importLine: 'import "mocha";\nimport * as assert from "assert";',
	suffix: "test.ts",
	languageId: "typescript",
};

const NODE_TEST: TestFramework = {
	name: "node:test",
	importLine: 'import { test } from "node:test";\nimport assert from "node:assert";',
	suffix: "test.ts",
	languageId: "typescript",
};

const PYTEST: TestFramework = {
	name: "pytest",
	importLine: "import pytest",
	suffix: "py",
	languageId: "python",
};

const GO_TEST: TestFramework = {
	name: "go test",
	importLine: 'import "testing"',
	suffix: "go",
	languageId: "go",
};

const CARGO_TEST: TestFramework = {
	name: "cargo test",
	importLine: "#[cfg(test)]\nmod tests {\n    use super::*;",
	suffix: "rs",
	languageId: "rust",
};

/** Paketnamn -> ramverk, i prioritetsordning. */
const PACKAGE_JSON_FRAMEWORKS: ReadonlyArray<readonly [string, TestFramework]> = [
	["vitest", VITEST],
	["jest", JEST],
	["@jest/globals", JEST],
	["mocha", MOCHA_TDD],
];

/**
 * Ramverket enligt package.json, eller undefined.
 *
 * Bara devDependencies och dependencies räknas. Att leta i node_modules hade
 * hittat varje transitivt beroende, och då vinner slumpen.
 */
export function frameworkFromPackageJson(json: unknown): TestFramework | undefined {
	if (!json || typeof json !== "object") {
		return undefined;
	}
	const pkg = json as Record<string, any>;
	const declared = {
		...(pkg.devDependencies ?? {}),
		...(pkg.dependencies ?? {}),
	};

	for (const [name, framework] of PACKAGE_JSON_FRAMEWORKS) {
		if (declared[name]) {
			return framework;
		}
	}

	// Inget testpaket alls men ett test-skript som kör node --test: nodes egen
	// testkörare kräver inget beroende, så den syns bara här.
	const script = String(pkg.scripts?.test ?? "");
	if (/\bnode\b.*--test\b/.test(script)) {
		return NODE_TEST;
	}

	return undefined;
}

/**
 * Mocha kan köras med tdd-ui (suite/test) eller bdd-ui (describe/it). Vilket
 * ett projekt använder syns inte i package.json:s beroenden utan i hur
 * mocha startas, så vi tittar efter det.
 */
export function mochaUi(json: unknown, mocharc?: string): TestFramework {
	const pkg = (json ?? {}) as Record<string, any>;
	const haystack = [
		String(pkg.scripts?.test ?? ""),
		String(pkg.mocha?.ui ?? ""),
		mocharc ?? "",
	].join(" ");

	if (/\btdd\b/.test(haystack)) {
		return MOCHA_TDD;
	}
	return {
		...MOCHA_TDD,
		name: "Mocha (bdd: describe/it)",
		importLine: 'import "mocha";\nimport * as assert from "assert";',
	};
}

/**
 * Ramverket som följer av SPRÅKET när projektet inte deklarerar något.
 * Go och Rust har testkörning inbyggd, så där finns inget att deklarera.
 */
export function frameworkFromLanguage(languageId: string): TestFramework | undefined {
	switch (languageId) {
		case "python":
			return PYTEST;
		case "go":
			return GO_TEST;
		case "rust":
			return CARGO_TEST;
		default:
			return undefined;
	}
}

/**
 * Sista utvägen när varken repot eller språket sagt något. Vitest är valt för
 * att det är default i moderna JS/TS-projekt och för att dess API är samma som
 * jests -- gissar vi fel är omskrivningen liten.
 */
export const FALLBACK_FRAMEWORK = VITEST;

/**
 * Sökvägen till testfilen för en källfil.
 *
 * Följer projektets egen konvention där den syns: ligger källfilen i src/
 * hamnar testet bredvid den, vilket är vad de flesta JS/TS-projekt gör. Go
 * kräver _test.go i samma mapp, och pytest vill ha test_-prefix.
 */
export function testPathFor(sourcePath: string, framework: TestFramework): string {
	const normalized = sourcePath.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	const dir = slash < 0 ? "" : normalized.slice(0, slash + 1);
	const file = normalized.slice(slash + 1);
	const stem = file.replace(/\.[^.]+$/, "");
	const ext = /\.([^.]+)$/.exec(file)?.[1] ?? "";

	if (framework === GO_TEST) {
		return `${dir}${stem}_test.go`;
	}
	if (framework === PYTEST) {
		return `${dir}test_${stem}.py`;
	}
	if (framework === CARGO_TEST) {
		// Rust lägger enhetstester i samma fil. Vi föreslår ändå en egen fil
		// under tests/ -- att skriva in i källfilen kräver att vi ändrar den,
		// och den här funktionen ska aldrig ge ett förslag som skriver över kod.
		return `${dir}${stem}_test.rs`;
	}
	// JS/TS: behåll källfilens ändelse så att .tsx-tester blir .tsx.
	const testExt = ext && /^[cm]?[jt]sx?$/.test(ext) ? ext : "ts";
	return `${dir}${stem}.test.${testExt}`;
}
