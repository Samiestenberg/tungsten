/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// KONTEXTFONSTRET som skickas till FIM-modellen, vid kanterna.
//
// Prefix och suffix ar det ENDA vi skickar till 1.5B:n, sa allt som kan bli fel
// i dem blir fel forslag. Fallen nedan ar de som faktiskt gar att traffa:
// markoren forst i filen, sist i filen, en tom fil, en jattefil -- och den som
// bar en riktig bugg: ett tecken utanfor BMP som hamnar precis pa klippgransen.

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';

const Module = require('module');
const OUT = path.join(__dirname, '..');

const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;

function fimCore(): any {
	const target = path.join(OUT, 'fim', 'fimCore.js');
	const fakeVscode = {
		workspace: {
			getConfiguration: () => ({
				get: (key: string) =>
					key === 'autocomplete.prefixChars' ? PREFIX_CHARS : SUFFIX_CHARS,
			}),
		},
	};
	const origLoad = Module._load;
	Module._load = function (request: string, ...rest: any[]) {
		if (request === 'vscode') {
			return fakeVscode;
		}
		return origLoad.call(this, request, ...rest);
	};
	try {
		delete require.cache[target];
		return require(target);
	} finally {
		Module._load = origLoad;
		delete require.cache[target];
	}
}

/** Bara det fimContext faktiskt ror av TextDocument. */
const doc = (text: string) => ({ getText: () => text }) as any;

/** En halv teckenkod -- en surrogat utan sin andra halva. */
function hasLoneSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return true;
			}
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return true;
		}
	}
	return false;
}

suite('FIM-kontext: kanterna', () => {

	test('markoren forst i filen ger tom prefix', () => {
		const { prefix, suffix } = fimCore().fimContext(doc('const a = 1;\n'), 0);
		assert.strictEqual(prefix, '');
		assert.strictEqual(suffix, 'const a = 1;\n');
	});

	test('markoren sist i filen ger tomt suffix', () => {
		const text = 'const a = 1;\n';
		const { prefix, suffix } = fimCore().fimContext(doc(text), text.length);
		assert.strictEqual(prefix, text);
		assert.strictEqual(suffix, '');
	});

	test('tom fil kraschar inte', () => {
		const { prefix, suffix } = fimCore().fimContext(doc(''), 0);
		assert.strictEqual(prefix, '');
		assert.strictEqual(suffix, '');
	});

	test('jattefil klipps till budgeten', () => {
		const big = 'x'.repeat(5_000_000);
		const { prefix, suffix } = fimCore().fimContext(doc(big), 2_500_000);
		assert.strictEqual(prefix.length, PREFIX_CHARS);
		assert.strictEqual(suffix.length, SUFFIX_CHARS);
	});
});

suite('FIM-kontext: tecken utanfor BMP pa klippgransen', () => {

	// JavaScript-strangar ar UTF-16 och slice() raknar KODENHETER. En emoji ar
	// tva kodenheter, sa ett klipp pa teckenbudgeten kan hamna mitt emellan dem.
	// Da gar en halv teckenkod over traden -- JSON:en blir syntaktiskt giltig, sa
	// inget fel marks hos oss, men det gar inte att koda som UTF-8.
	//
	// Uppmatt fore fixen:  suffix len=1000  lone-surrogate=true
	const EMOJI = '\u{1F600}'; // tva kodenheter

	test('KRITISKT: suffixets klipp delar inte ett surrogatpar', () => {
		// Lagg emojin sa att klippet vid SUFFIX_CHARS hamnar mitt i den.
		const text = 'b'.repeat(SUFFIX_CHARS - 1) + EMOJI + 'c'.repeat(500);
		const { suffix } = fimCore().fimContext(doc(text), 0);
		assert.ok(!hasLoneSurrogate(suffix), 'suffixet slutar med en halv teckenkod');
	});

	test('KRITISKT: prefixets klipp delar inte ett surrogatpar', () => {
		// Klippet ligger vid offset - PREFIX_CHARS; lagg emojin dar.
		const text = 'a'.repeat(50) + EMOJI + 'b'.repeat(PREFIX_CHARS - 1);
		const { prefix } = fimCore().fimContext(doc(text), text.length);
		assert.ok(!hasLoneSurrogate(prefix), 'prefixet borjar med en halv teckenkod');
	});

	test('en emoji som ryms HELT lamnas orord', () => {
		// Fixen far inte ata tecken som faktiskt ar kompletta.
		const text = `const smiley = "${EMOJI}";\n`;
		const { prefix, suffix } = fimCore().fimContext(doc(text), text.length);
		assert.strictEqual(prefix, text, 'ett komplett tecken kapades');
		assert.strictEqual(suffix, '');
		assert.ok(prefix.includes(EMOJI));
	});

	test('bade prefix och suffix overlever ett par mitt i filen', () => {
		const text = 'a'.repeat(100) + EMOJI + 'b'.repeat(100);
		const { prefix, suffix } = fimCore().fimContext(doc(text), 100);
		assert.ok(!hasLoneSurrogate(prefix));
		assert.ok(!hasLoneSurrogate(suffix));
		// Markoren star FORE emojin, sa hela paret hor till suffixet.
		assert.ok(suffix.startsWith(EMOJI));
	});
});
