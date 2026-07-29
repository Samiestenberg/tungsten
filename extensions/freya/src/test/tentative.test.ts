/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester for de TENTATIVA FIM-lagena (fim/tentative.ts).
//
// De tre lagena gissar en gnutta avsikt, till skillnad fran resten av
// FIM-lanen som bara fortsatter det som redan star dar. Darfor ar det som
// testas har framst NAR de INTE ska utlosa: ett tentativt lage som fyrar pa
// fel stalle ar en gissning anvandaren inte bad om, pa en plats dar den
// sakra kompletteringen hade varit battre.

import 'mocha';
import * as assert from 'assert';
import { classifyTentative, isTestFile, trimRegexSuggestion } from '../fim/tentative.js';

const TS = 'typescript';
const PLAIN_FILE = '/repo/src/app.ts';
const TEST_FILE = '/repo/src/app.test.ts';

function prefixOf(...lines: string[]): string {
	return lines.join('\n');
}

suite('Tentativa lagen: testfilsigenkanning', () => {

	test('vanliga testfilsnamn', () => {
		assert.ok(isTestFile('/repo/src/app.test.ts'));
		assert.ok(isTestFile('/repo/src/app.spec.tsx'));
		assert.ok(isTestFile('C:\\repo\\src\\thing.test.js'));
		assert.ok(isTestFile('/repo/__tests__/app.ts'));
		assert.ok(isTestFile('/repo/test/helpers.ts'));
		assert.ok(isTestFile('/repo/pkg/thing_test.go'));
		assert.ok(isTestFile('/repo/tests/test_thing.py'));
	});

	test('KONTROLLFALL: vanliga kallfiler ar inte testfiler', () => {
		assert.ok(!isTestFile('/repo/src/app.ts'));
		assert.ok(!isTestFile('/repo/src/latest.ts'));
		assert.ok(!isTestFile('/repo/src/contest.js'));
		assert.ok(!isTestFile('/repo/src/testing-utils.ts'));
	});
});

suite('Tentativa lagen: regex-literal', () => {

	test('markoren precis efter .replace(/', () => {
		const plan = classifyTentative('  const slug = title.replace(/', TS, PLAIN_FILE);
		assert.strictEqual(plan?.tentativeKind, 'regex');
		assert.strictEqual(plan?.multiline, false);
	});

	test('ocksa efter .match(/ och .split(/', () => {
		assert.strictEqual(classifyTentative('const m = s.match(/', TS, PLAIN_FILE)?.tentativeKind, 'regex');
		assert.strictEqual(classifyTentative('const p = s.split(/', TS, PLAIN_FILE)?.tentativeKind, 'regex');
	});

	test('KRITISKT: vanlig division ar ingen regex', () => {
		// Utan kravet pa metodnamnet hade varje snedstreck sett ut som ett
		// oppnat monster.
		assert.strictEqual(classifyTentative('const half = total / ', TS, PLAIN_FILE), undefined);
		assert.strictEqual(classifyTentative('const r = a(b) / ', TS, PLAIN_FILE), undefined);
	});

	test('KONTROLLFALL: monstret ar redan stangt', () => {
		assert.strictEqual(classifyTentative('title.replace(/\\s+/', TS, PLAIN_FILE), undefined);
	});

	test('KONTROLLFALL: python har ingen regex-literal', () => {
		assert.strictEqual(classifyTentative('s.replace(/', 'python', PLAIN_FILE), undefined);
	});
});

suite('Tentativa lagen: klipp regexen dar monstret slutar', () => {

	test('REFERENSFALL: ordagrant svar fran 1.5B som fortsatte for langt', () => {
		// Uppmatt mot modellen, prefix `title.toLowerCase().replace(/`,
		// suffix `, "-");`. Monstret var ratt; den skrev bara om resten av
		// raden som redan fanns i suffixet.
		const raw = ' /g, "-").replace(/[^a-z0-9-]/g, "");';
		assert.strictEqual(trimRegexSuggestion(raw), ' /g');
	});

	test('flaggorna foljer med', () => {
		assert.strictEqual(trimRegexSuggestion('\\s+/gi, "")'), '\\s+/gi');
		assert.strictEqual(trimRegexSuggestion('a/'), 'a/');
	});

	test('KRITISKT: ett escapat snedstreck ar inte slutet', () => {
		assert.strictEqual(trimRegexSuggestion('https:\\/\\/x/g, "")'), 'https:\\/\\/x/g');
	});

	test('KRITISKT: ett snedstreck i en teckenklass ar inte slutet', () => {
		assert.strictEqual(trimRegexSuggestion('[a-z/]+/g, "")'), '[a-z/]+/g');
	});

	test('ofullstandigt monster ges tillbaka som det ar', () => {
		// Anvandaren skriver klart det sjalv; battre an att kasta bort borjan.
		assert.strictEqual(trimRegexSuggestion('[a-z0-9'), '[a-z0-9');
	});

	test('bara forsta raden', () => {
		assert.strictEqual(trimRegexSuggestion('\\d+/g\nconst x = 1;'), '\\d+/g');
	});
});

suite('Tentativa lagen: felhanterare', () => {

	test('tom rad i en catch-kropp -> block', () => {
		const plan = classifyTentative(prefixOf('try {', '  risky();', '} catch (err) {', '  '), TS, PLAIN_FILE);
		assert.strictEqual(plan?.tentativeKind, 'error-handler');
		assert.strictEqual(plan?.multiline, true);
	});

	test('pythons except raknas ocksa', () => {
		const plan = classifyTentative(prefixOf('try:', '    risky()', 'except ValueError as e:', '    '), 'python', PLAIN_FILE);
		assert.strictEqual(plan?.tentativeKind, 'error-handler');
	});

	test('markoren precis efter .catch( -> enradigt', () => {
		const plan = classifyTentative('  fetchUser(id).catch(', TS, PLAIN_FILE);
		assert.strictEqual(plan?.tentativeKind, 'error-handler');
		assert.strictEqual(plan?.multiline, false);
	});

	test('KRITISKT: blocket klipps mot catch-radens indentering', () => {
		const plan = classifyTentative(prefixOf('  } catch (e) {', '    '), TS, PLAIN_FILE);
		assert.strictEqual(plan?.baseIndent, '  ');
	});

	test('KONTROLLFALL: ett vanligt block ar ingen felhanterare', () => {
		assert.strictEqual(classifyTentative(prefixOf('if (x) {', '  '), TS, PLAIN_FILE), undefined);
	});

	test('KONTROLLFALL: catch i en kommentar', () => {
		assert.strictEqual(classifyTentative(prefixOf('// } catch (e) {', '  '), TS, PLAIN_FILE), undefined);
	});
});

suite('Tentativa lagen: test-skelett', () => {

	test('tom rad i ett describe-block i en testfil', () => {
		const plan = classifyTentative(prefixOf('describe("totalPrice", () => {', '  '), TS, TEST_FILE);
		assert.strictEqual(plan?.tentativeKind, 'test-skeleton');
		assert.strictEqual(plan?.multiline, true);
	});

	test('suite() raknas ocksa', () => {
		const plan = classifyTentative(prefixOf('suite("parser", () => {', '  '), TS, TEST_FILE);
		assert.strictEqual(plan?.tentativeKind, 'test-skeleton');
	});

	test('KRITISKT: samma kod i en KALLFIL ar inget testskelett', () => {
		// Utan filnamnsvillkoret hade varje describe-liknande anrop i vanlig kod
		// gett testforslag.
		assert.strictEqual(classifyTentative(prefixOf('describe("x", () => {', '  '), TS, PLAIN_FILE), undefined);
	});

	test('KONTROLLFALL: en testfil utan oppnat describe-block', () => {
		assert.strictEqual(classifyTentative(prefixOf('const helper = 1;', ''), TS, TEST_FILE), undefined);
	});
});

suite('Tentativa lagen: allt annat lamnas till de sakra lagena', () => {

	test('mitt i en vanlig rad', () => {
		assert.strictEqual(classifyTentative('  const x = ', TS, PLAIN_FILE), undefined);
	});

	test('tom rad efter en vanlig funktionssignatur', () => {
		assert.strictEqual(classifyTentative(prefixOf('function f() {', '  '), TS, PLAIN_FILE), undefined);
	});

	test('tomt prefix kraschar inte', () => {
		assert.strictEqual(classifyTentative('', TS, PLAIN_FILE), undefined);
	});

	test('gissningarna har LAGRE tokenbudget an de sakra lagena', () => {
		// En gissning ska inte kosta lika mycket vantan som ett sakert svar.
		// Det sakra blocklaget ar 96.
		const block = classifyTentative(prefixOf('} catch (e) {', '  '), TS, PLAIN_FILE);
		assert.ok(block!.maxTokens < 96, `tentativt block var ${block!.maxTokens} tokens`);
		const expr = classifyTentative('s.replace(/', TS, PLAIN_FILE);
		assert.ok(expr!.maxTokens <= 28, `tentativt uttryck var ${expr!.maxTokens} tokens`);
	});
});
