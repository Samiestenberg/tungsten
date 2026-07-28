/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester för next-edit-förutsägelsens VAR-del (nextEditMatch.ts).
//
// Den här modulen bestämmer vilka rader som får ett förslag. Två sorters fel
// finns, och de kostar olika mycket:
//
//   Falskt NEGATIVT (missar en rad som borde ändras): användaren märker
//   ingenting, funktionen var bara tyst den gången. Billigt.
//
//   Falskt POSITIVT (föreslår på en rad som inte har med saken att göra):
//   användaren tappar förtroendet och slutar titta på förslaget. Dyrt.
//
// Därför är tröskeln sträng och kontrollfallen nedan fler än träfffallen.

import 'mocha';
import * as assert from 'assert';
import {
	findEditSiblings,
	isMeaningfulEdit,
	lineSimilarity,
	lineTokens,
	SIMILARITY_THRESHOLD,
} from '../fim/nextEditMatch.js';

suite('Next edit: radlikhet', () => {

	test('tokeniseringen släpper indentering och skiljetecken', () => {
		assert.deepStrictEqual(lineTokens('  const a = getUser(id);'), ['const', 'a', 'getUser', 'id']);
	});

	test('identiska rader är helt lika', () => {
		assert.strictEqual(lineSimilarity('foo.bar(1)', 'foo.bar(1)'), 1);
	});

	test('samma anrop med annat variabelnamn är över tröskeln', () => {
		const sim = lineSimilarity('const a = getUser(id);', 'const b = getUser(id);');
		assert.ok(sim >= SIMILARITY_THRESHOLD, `similarity ${sim}`);
	});

	test('helt olika rader är under tröskeln', () => {
		const sim = lineSimilarity('const a = getUser(id);', 'return total * 2;');
		assert.ok(sim < SIMILARITY_THRESHOLD, `similarity ${sim}`);
	});

	test('tomma rader ger noll i stället för att krascha', () => {
		assert.strictEqual(lineSimilarity('', 'foo()'), 0);
		assert.strictEqual(lineSimilarity('   ', ''), 0);
	});

	test('bara indentering skiljer -> fortfarande samma rad', () => {
		assert.strictEqual(lineSimilarity('foo(bar)', '\t\t\tfoo(bar)'), 1);
	});
});

suite('Next edit: vilka andringar ar vard att folja upp', () => {

	test('utbytt metodnamn ar en riktig andring', () => {
		assert.ok(isMeaningfulEdit('user.getName()', 'user.getFullName()'));
	});

	test('KONTROLLFALL: nagon som skriver mitt i ett ord ar inte en andring', () => {
		// "getNa" -> "getNam" medan man skriver. Inget nytt token, ingen
		// forutsagelse.
		assert.ok(!isMeaningfulEdit('user.getNa', 'user.getNa'));
	});

	test('KONTROLLFALL: bara blanktecken andrades', () => {
		assert.ok(!isMeaningfulEdit('  foo()', '    foo()'));
	});

	test('KONTROLLFALL: tom rad ar aldrig ett monster', () => {
		assert.ok(!isMeaningfulEdit('', 'foo()'));
		assert.ok(!isMeaningfulEdit('foo()', '   '));
	});

	test('KONTROLLFALL: raden blev nagot helt annat', () => {
		// En rad som skrivits om fran grunden ar en NY rad, inte en andring att
		// upprepa nagon annanstans.
		assert.ok(!isMeaningfulEdit('const a = 1;', 'await db.close();'));
	});
});

suite('Next edit: hitta syskonraderna', () => {

	const FILE = [
		'function render(user) {',            // 0
		'  const name = user.getFullName();', // 1  <- redan andrad (origin)
		'  const age = user.getAge();',       // 2
		'  const city = user.getCity();',     // 3
		'',                                   // 4
		'  return name + age + city;',        // 5
		'}',                                  // 6
	];

	test('hittar de andra raderna av samma sort, narmast forst', () => {
		const siblings = findEditSiblings(FILE, '  const name = user.getName();', '  const name = user.getFullName();', 1);
		assert.deepStrictEqual(siblings.map(s => s.line), [2, 3]);
	});

	test('ursprungsraden foreslas aldrig for sig sjalv', () => {
		const siblings = findEditSiblings(FILE, '  const name = user.getName();', '  const name = user.getFullName();', 1);
		assert.ok(!siblings.some(s => s.line === 1));
	});

	test('KRITISKT: rader som redan har malformen hoppas over', () => {
		// Annars foreslar vi samma andring om och om igen pa rader som ar klara.
		const done = [...FILE];
		done[2] = '  const age = user.getAge();';
		const siblings = findEditSiblings(done, '  const age = user.getAge();', '  const age = user.getAge();', 1);
		assert.ok(!siblings.some(s => s.line === 2), 'foreslog en rad som redan var i malform');
	});

	test('tomma rader och orelaterad kod kommer inte med', () => {
		const siblings = findEditSiblings(FILE, '  const name = user.getName();', '  const name = user.getFullName();', 1);
		assert.ok(!siblings.some(s => s.line === 4), 'tom rad kom med');
		assert.ok(!siblings.some(s => s.line === 6), 'en ensam klammer kom med');
	});

	test('rader ovanfor kommer efter rader nedanfor', () => {
		// Blicken ar pa vag nedat i filen; foresla dar forst.
		const siblings = findEditSiblings(FILE, '  const city = user.getCity();', '  const city = user.getHomeCity();', 3);
		assert.deepStrictEqual(siblings.map(s => s.line), [2, 1]);
	});

	test('inget att foresla i en fil utan liknande rader', () => {
		const other = ['import fs from "fs";', 'export const PORT = 3000;'];
		assert.deepStrictEqual(findEditSiblings(other, 'user.getName()', 'user.getFullName()', 0), []);
	});
});
