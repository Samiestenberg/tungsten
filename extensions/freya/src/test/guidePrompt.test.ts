/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester for guide-chattens system-prompt.
//
// VARFOR DE HAR TESTERNA FINNS. Guiden ar den enda ytan dar modellen pastar
// saker om PRODUKTEN. Uppmatt beteende utan fakta i prompten:
//
//   Fraga:  "How do I turn off inline completions?"
//   Svar:   "go to the editor settings and find the Editor: Completion
//            section. Look for Show inline completions and uncheck it."
//
// Sjalvsakert, hjalpsamt formulerat, och helt pahittat. En guide som inte VET
// produkten gissar den.
//
// Fixen var att lagga in de riktiga namnen i prompten. Risken med den fixen ar
// att de driver isar: nagon doper om ett kommando, prompten star kvar, och
// guiden blir en lognare igen -- tyst. Testerna nedan ar sparren mot det. De
// laser package.json och kraver att varje namn prompten namner faktiskt finns.

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GUIDE_COMMANDS, GUIDE_SETTINGS, GUIDE_SYSTEM } from '../guidePrompt.js';

function manifest(): any {
	return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

suite('Guide-chatt: prompten ljuger inte om produkten', () => {

	test('varje kommando guiden far namna finns registrerat', () => {
		const registered = new Set<string>(
			(manifest().contributes?.commands ?? []).map((c: any) => c.command)
		);
		for (const command of GUIDE_COMMANDS) {
			assert.ok(
				registered.has(command),
				`${command} namns i guide-prompten men finns inte i package.json`
			);
		}
	});

	test('varje installning guiden far namna finns deklarerad', () => {
		const declared = new Set(
			Object.keys(manifest().contributes?.configuration?.properties ?? {})
		);
		for (const setting of GUIDE_SETTINGS) {
			assert.ok(
				declared.has(setting),
				`${setting} namns i guide-prompten men finns inte i package.json`
			);
		}
	});

	test('KRITISKT: varje freya.*-installning som STAR i prompttexten finns', () => {
		// Bredare an listan ovan: fangar en installning som skrivs in i
		// prompttexten utan att laggas till i GUIDE_SETTINGS.
		const declared = new Set(
			Object.keys(manifest().contributes?.configuration?.properties ?? {})
		);
		const mentioned = GUIDE_SYSTEM.match(/\bfreya\.[a-zA-Z.]+[a-zA-Z]/g) ?? [];
		for (const setting of new Set(mentioned)) {
			assert.ok(
				declared.has(setting),
				`prompten namner ${setting}, som inte ar en riktig installning`
			);
		}
	});

	test('KRITISKT: tangentbindningarna i prompten ar de som faktiskt galler', () => {
		// Uppmatt fel i en tidigare version: prompten sade "Cmd+K" for inline
		// edit medan bindningen ar ctrl+k ctrl+i. En guide som skickar folk
		// till en genvag som inte finns ar samre an ingen guide.
		const bindings: any[] = manifest().contributes?.keybindings ?? [];
		const prompt = GUIDE_SYSTEM.toLowerCase();

		// Ett kommando kan ha FLERA bindningar (inline edit har tva: bar ctrl+k
		// med markering, och ackordet ctrl+k ctrl+i utan). Varenda en som finns
		// maste ga att hitta i prompten, annars skickar guiden folk till en
		// genvag som inte gor det den tror.
		for (const command of ['freya.inlineEdit', 'freya.refactor']) {
			const keys = bindings.filter((b: any) => b.command === command).map((b: any) => String(b.key));
			assert.ok(keys.length > 0, `${command} har ingen tangentbindning`);
			for (const key of keys) {
				assert.ok(
					prompt.includes(key.toLowerCase()),
					`prompten namner inte den faktiska bindningen "${key}" for ${command}`
				);
			}
		}
	});

	test('KRITISKT: bara Ctrl+K MED markering far ta ackord-prefixet', () => {
		// Bar ctrl+k ar prefixet for hela VS Codes ackord-familj. Utan
		// editorHasSelection i when-uttrycket skulle bindningen svalja ctrl+k
		// helt och ctrl+k ctrl+s, ctrl+k z osv sluta fungera. Se filhuvudet i
		// inlineEdit.ts for hur resolvern gor att de tva kan samexistera.
		const bindings: any[] = manifest().contributes?.keybindings ?? [];
		const bare = bindings.filter((b: any) => String(b.key).trim() === 'ctrl+k');
		assert.strictEqual(bare.length, 1, 'forvantade exakt en bar ctrl+k-bindning');
		assert.ok(
			String(bare[0].when).includes('editorHasSelection'),
			`bar ctrl+k saknar editorHasSelection i when: ${bare[0].when}`
		);
		assert.strictEqual(bare[0].command, 'freya.inlineEdit');
	});
});

suite('Guide-chatt: scopet star kvar', () => {

	test('sager uttryckligen att den inte kan lasa eller skriva filer', () => {
		assert.ok(/cannot read or write files/i.test(GUIDE_SYSTEM));
		assert.ok(/cannot run commands/i.test(GUIDE_SYSTEM));
	});

	test('KRITISKT: forbjuder att skriva ut en omskriven version', () => {
		// Den har regeln ar den som faktiskt fungerade. "Point the user to
		// inline edit" ensamt racket inte -- pa "refactor all the API calls in
		// my repo" svarade 3B med 33 sekunders pahittad Go-kod anda. Regeln
		// maste FORBJUDA det andra, inte bara beskriva det onskade.
		assert.ok(
			/do NOT write out a rewritten version/i.test(GUIDE_SYSTEM),
			'forbudet mot att skriva ut en omskrivning ar borta ur prompten'
		);
	});

	test('ber om korta svar och anvandarens sprak', () => {
		assert.ok(/keep answers short/i.test(GUIDE_SYSTEM));
		assert.ok(/user's language/i.test(GUIDE_SYSTEM));
	});

	test('sager att allt kor lokalt', () => {
		assert.ok(/no account/i.test(GUIDE_SYSTEM));
		assert.ok(/no network/i.test(GUIDE_SYSTEM));
	});

	test('positionerar sig INTE som avancerad kodagent', () => {
		// Ordval som skulle lova mer an lanen kan halla.
		for (const forbidden of ['autonomous', 'agent', 'I will edit', 'I can modify']) {
			assert.ok(
				!new RegExp(forbidden, 'i').test(GUIDE_SYSTEM),
				`prompten anvander "${forbidden}", vilket positionerar guiden fel`
			);
		}
	});

	test('prompten ar kort nog att inte ata kontextfonstret', () => {
		// 3B kor med 8192 tokens. En system-prompt over ~1200 tecken borjar
		// tranga ut historiken, och en 3B som far bada tappar bada.
		assert.ok(
			GUIDE_SYSTEM.length < 2200,
			`system-prompten ar ${GUIDE_SYSTEM.length} tecken`
		);
	});
});
