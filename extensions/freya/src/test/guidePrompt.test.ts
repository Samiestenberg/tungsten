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
import { GUIDE_COMMANDS, GUIDE_SETTINGS, GUIDE_SHOTS, GUIDE_STOP, GUIDE_SYSTEM } from '../guidePrompt.js';

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

	test('sager uttryckligen att den inte kan skapa, lasa eller andra filer', () => {
		// SKAPA star med FOR ATT DET MATTES. Med den gamla lydelsen ("You cannot
		// read files, write files, ...") svarade Granite pa en rak begaran:
		//
		//   "Can you create a new file called utils.py for me?"
		//   -> "Sure, I can create a new file for you. Select the text ... then
		//       choose 'Create new file'."
		//
		// Alltsa agent-loftet, plus en pahittad meny. Modellen generaliserade
		// inte "write" till "create". Med "create files" i upprakningen blev
		// svaret "I cannot create files -- I only see what you type here."
		//
		// Testet ar skrivet mot VERBEN och inte mot en ordfoljd, sa att raden gar
		// att formulera om -- men ingen av de tre formagorna kan tappas bort.
		for (const verb of ['create', 'read', 'change']) {
			assert.ok(
				new RegExp(`cannot[^.]*\\b${verb}\\b[^.]*files`, 'i').test(GUIDE_SYSTEM),
				`system-prompten sager inte att guiden inte kan ${verb} filer`
			);
		}
		assert.ok(/run commands/i.test(GUIDE_SYSTEM));
		assert.ok(/open a repository/i.test(GUIDE_SYSTEM));
	});

	test('KRITISKT: gransen demonstreras, inte bara beskrivs', () => {
		// Regeln bars numera av ett FA-SKOTTS-EXEMPEL och inte av en mening i
		// system-prompten. Skalet star i guidePrompt.ts: Granite ignorerade den
		// beskrivna regeln ("Sure, I can help you with that. Please provide me
		// with the repository URL") men foljde det visade exemplet.
		//
		// Testet provar darfor EGENSKAPEN over bada artefakterna: det maste
		// finnas ett exempel dar anvandaren ber om en andring i projektet och
		// svaret bade nekar OCH pekar pa Ctrl+K.
		const ask = GUIDE_SHOTS.findIndex(
			shot => shot.role === 'user' && /\b(my project|my repo|repository|everywhere)\b/i.test(shot.content)
		);
		assert.ok(ask >= 0, 'inget fa-skotts-exempel dar anvandaren ber om ett agent-jobb');

		const answer = GUIDE_SHOTS[ask + 1];
		assert.ok(answer && answer.role === 'assistant', 'exemplet saknar svar');
		assert.ok(
			/cannot (open|read|change)/i.test(answer.content),
			`exempelsvaret nekar inte: ${answer.content}`
		);
		assert.ok(
			/ctrl\+k/i.test(answer.content),
			`exempelsvaret pekar inte pa inline edit: ${answer.content}`
		);
	});

	test('KRITISKT: stoppsekvenserna hor ihop med fa-skotts-exemplen', () => {
		// Med exemplen pa plats fortsatte Granite efter sitt svar och skrev NYA
		// Question/Answer-par -- den hade lart sig monstret for val. Stoppen
		// klipper dar. Tar man bort det ena maste man ompröva det andra.
		assert.ok(GUIDE_SHOTS.length > 0, 'inga fa-skotts-exempel');
		assert.ok(
			GUIDE_STOP.some(s => /question:/i.test(s)),
			'stoppet pa Granites Question:-mall saknas'
		);
	});

	test('fa-skotts-exemplen ar hela par och borjar med anvandaren', () => {
		assert.strictEqual(GUIDE_SHOTS.length % 2, 0, 'ett exempel saknar sitt svar');
		assert.strictEqual(GUIDE_SHOTS[0].role, 'user');
		GUIDE_SHOTS.forEach((shot, i) => {
			assert.strictEqual(shot.role, i % 2 === 0 ? 'user' : 'assistant', `tur ${i} har fel roll`);
		});
	});

	test('ber om korta svar och anvandarens sprak', () => {
		assert.ok(/two or three sentences/i.test(GUIDE_SYSTEM));
		assert.ok(/never with numbered steps/i.test(GUIDE_SYSTEM));
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
