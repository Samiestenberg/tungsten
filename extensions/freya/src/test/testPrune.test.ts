/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester for stadningen av genererade testfiler (testPrune.ts).
//
// REFERENSFALLET nedan ar ordagrant fran 3B:n. Den ombads skriva tester for
// clampToLines() och borjade bra -- och fastnade sedan i namn som var
// foregaende namn plus ett led, tills tokentaket tog slut mitt i en strang.
// Det ar den degenereringen den har modulen finns for.

import 'mocha';
import * as assert from 'assert';
import { openStack, pruneGeneratedTests, testName } from '../testPrune.js';

suite('Testgenerering: plocka ut testnamnet', () => {

	test('strangliteral i it()', () => {
		assert.strictEqual(testName('  it("handles empty text", () => {'), 'handles empty text');
	});

	test('enkelfnuttar och backticks', () => {
		assert.strictEqual(testName("  it('does a thing', () => {"), 'does a thing');
		assert.strictEqual(testName('  test(`does a thing`, () => {'), 'does a thing');
	});

	test('python och go har namnet i identifieraren', () => {
		assert.strictEqual(testName('def test_handles_empty_text():'), 'handles_empty_text');
		assert.strictEqual(testName('func TestHandlesEmptyText(t *testing.T) {'), 'HandlesEmptyText');
	});

	test('rad utan namn ger undefined', () => {
		assert.strictEqual(testName('  expect(x).toBe(1);'), undefined);
	});
});

suite('Testgenerering: oppna klamrar som stack', () => {

	test('balanserad kod ger tom stack', () => {
		assert.deepStrictEqual(openStack('describe("x", () => {\n  it("y", () => {});\n});'), []);
	});

	test('oppen describe ger stacken i ratt ordning', () => {
		assert.deepStrictEqual(openStack('describe("x", () => {\n  it("y", () => {'), ['(', '{', '(', '{']);
	});

	test('KRITISKT: klamrar i en STRANG raknas inte', () => {
		// Annars hade varje test som jamfor JSON-text sett ut som obalanserat.
		assert.deepStrictEqual(openStack('expect(s).toBe("{ (unbalanced");'), []);
	});

	test('KRITISKT: klamrar i en KOMMENTAR raknas inte', () => {
		assert.deepStrictEqual(openStack('// describe("x", () => {\nconst a = 1;'), []);
		assert.deepStrictEqual(openStack('/* it("y", () => { */\nconst a = 1;'), []);
		assert.deepStrictEqual(openStack('# def test(): {\na = 1'), []);
	});

	test('escape i en strang forvirrar inte stacken', () => {
		assert.deepStrictEqual(openStack('const s = "a\\"{";'), []);
	});
});

suite('Testgenerering: klipp upprepningar och balansera', () => {

	test('en bra testfil lamnas ORORD', () => {
		const good = [
			'import { describe, it, expect } from "vitest";',
			'import { clampToLines } from "./instructText";',
			'',
			'describe("clampToLines", () => {',
			'  it("returns the text unchanged when it fits", () => {',
			'    expect(clampToLines("abc", 10)).toBe("abc");',
			'  });',
			'',
			'  it("cuts at the last newline before the cap", () => {',
			'    expect(clampToLines("a\\nb\\nc", 3)).toBe("a\\nb");',
			'  });',
			'});',
		].join('\n');
		assert.strictEqual(pruneGeneratedTests(good), good);
	});

	test('REFERENSFALL Qwen: en LOPANDE serie nastan identiska namn klipps', () => {
		// Ordagrant monster fran Qwen: varje namn ar foregaende plus ett led,
		// och serien fortsatte tills tokentaket tog slut mitt i en strang.
		const degenerate = [
			'import { describe, it, expect } from "vitest";',
			'',
			'describe("clampToLines", () => {',
			'  it("should handle empty text", () => {',
			'    expect(clampToLines("", 10)).toBe("");',
			'  });',
			'',
			'  it("should handle maxChars equal to text length with a newline and a space", () => {',
			'    expect(clampToLines("Hello\\nworld! ", 12)).toBe("Hello\\nworld! ");',
			'  });',
			'',
			'  it("should handle maxChars equal to text length with a newline and a space at the end", () => {',
			'    expect(clampToLines("Hello\\nworld! ", 13)).toBe("Hello\\nworld! ");',
			'  });',
			'',
			'  it("should handle maxChars equal to text length with a newline and a space at the beginning and end", () => {',
			'    expect(clampToLines(" Hello\\nworld! ", 13)).toBe(" Hello\\nworld! ");',
			'  });',
			'',
			'  it("should handle maxChars equal to text length with a newline and a space at the beginning and end and a trailing space", () => {',
		].join('\n');

		const pruned = pruneGeneratedTests(degenerate);

		// Det forsta, genuint egna fallet finns kvar ...
		assert.ok(pruned.includes('should handle empty text'));
		// ... och hela serien ar borta, fran dess borjan.
		assert.ok(!pruned.includes('at the end'), 'serien levde kvar');
		assert.ok(!pruned.includes('at the beginning and end'), 'serien levde kvar');
		assert.ok(!pruned.includes('trailing space'), 'serien levde kvar');
		// ... och filen ar balanserad igen.
		assert.deepStrictEqual(openStack(pruned), [], 'filen lamnades obalanserad');
		assert.ok(pruned.trimEnd().endsWith('});'), `slutade med: ${JSON.stringify(pruned.slice(-20))}`);
	});

	test('REFERENSFALL Granite: ETT likt par ar normalt och far INTE klippas', () => {
		// Ordagrant svar fran granite-3b-code-instruct. De tva sista namnen
		// ligger runt 0,9 av varandra -- samma spann som Qwens degenererade
		// namn -- men de testar OLIKA grenar (det andra traffar cut > maxChars/2).
		// Den forsta versionen av pruningen at det sista testet.
		const good = [
			'import { describe, it, expect } from "vitest";',
			'import { clampToLines } from "./instructText";',
			'',
			'describe("clampToLines", () => {',
			'  it("returns the text if it\'s less than or equal to the max length", () => {',
			'    expect(clampToLines("Hello world", 10)).toBe("Hello world");',
			'  });',
			'',
			'  it("returns the first line of the text if it\'s longer than the max length", () => {',
			'    expect(clampToLines("Hello world\\nSecond", 10)).toBe("Hello world");',
			'  });',
			'',
			'  it("returns the first line of the text if it\'s longer than half the max length", () => {',
			'    expect(clampToLines("Hello world\\nSecond", 5)).toBe("Hello world");',
			'  });',
			'});',
		].join('\n');

		assert.strictEqual(pruneGeneratedTests(good), good, 'ett legitimt test klipptes bort');
		assert.strictEqual((pruneGeneratedTests(good).match(/\bit\(/g) ?? []).length, 3);
	});

	test('avhugget svar UTAN upprepning balanseras anda', () => {
		// Tokentaket tog slut mitt i det sista testet. Ett halvskrivet test ska
		// inte visas -- det ar trasig kod, inte ett forslag.
		const cut = [
			'describe("x", () => {',
			'  it("first", () => {',
			'    expect(1).toBe(1);',
			'  });',
			'',
			'  it("second thing that never finished", () => {',
			'    expect(compute(',
		].join('\n');

		const pruned = pruneGeneratedTests(cut);
		assert.ok(pruned.includes('"first"'));
		assert.ok(!pruned.includes('never finished'), 'det halvskrivna testet levde kvar');
		assert.deepStrictEqual(openStack(pruned), []);
	});

	test('avhugget utan nagot testfall alls balanseras', () => {
		const pruned = pruneGeneratedTests('describe("x", () => {\n  const fixture = {');
		assert.deepStrictEqual(openStack(pruned), []);
	});

	test('olika testnamn utlöser INGEN klippning', () => {
		// Kontrollfall: fallen nedan ar besläktade men inte upprepningar.
		const varied = [
			'describe("x", () => {',
			'  it("handles empty input", () => { expect(f("")).toBe(""); });',
			'  it("cuts at the last newline", () => { expect(f("a\\nb", 2)).toBe("a"); });',
			'  it("throws on a negative cap", () => { expect(() => f("a", -1)).toThrow(); });',
			'});',
		].join('\n');
		assert.strictEqual(pruneGeneratedTests(varied), varied);
	});

	test('python: inga klamrar att balansera', () => {
		const py = [
			'import pytest',
			'',
			'def test_returns_text_when_it_fits():',
			'    assert clamp("abc", 10) == "abc"',
			'',
			'def test_returns_text_when_it_fits_exactly():',
			'    assert clamp("abc", 3) == "abc"',
		].join('\n');
		const pruned = pruneGeneratedTests(py);
		// Namnen ar nastan identiska -> det andra klipps, och inget behover stangas.
		assert.ok(pruned.includes('test_returns_text_when_it_fits:') || pruned.includes('test_returns_text_when_it_fits('));
		assert.deepStrictEqual(openStack(pruned), []);
	});

	test('tom indata kraschar inte', () => {
		assert.strictEqual(pruneGeneratedTests(''), '');
	});
});
