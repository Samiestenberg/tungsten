/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester för den delade instruct-runnern (3B-lanen).
//
// Två saker testas här, och de är olika sorter:
//
//   1. stripCodeFences är en ren funktion med ett konkret syfte: en 3B-modell
//      lägger kod i ```-block även när instruktionen säger nej, och det som
//      klistras in i källfilen får inte innehålla staket. Fallen nedan är
//      formerna modellen faktiskt producerar.
//
//   2. ARKITEKTURTESTET längst ner. Lagen "ingen tool-calling någonstans i
//      instruct-lanen" är inte en kodkommentar man kan glömma bort utan en
//      egenskap som ska gå att bevisa. Testet läser modulens källkod och
//      faller om någon börjar skicka verktyg eller tolka verktygsanrop.

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	cacheKey,
	clampToLines,
	commonIndent,
	isIdentifier,
	parseList,
	reindent,
	stripCodeFences,
} from '../instructText.js';

suite('Instruct: markdown-staket', () => {

	test('vanligt ```-block med språknamn', () => {
		const raw = ['```typescript', 'const x = 1;', '```'].join('\n');
		assert.strictEqual(stripCodeFences(raw), 'const x = 1;');
	});

	test('```-block utan språknamn', () => {
		assert.strictEqual(stripCodeFences('```\nconst x = 1;\n```'), 'const x = 1;');
	});

	test('flera rader behåller sin indentering', () => {
		const raw = [
			'```js',
			'function f() {',
			'\treturn 1;',
			'}',
			'```',
		].join('\n');
		assert.strictEqual(stripCodeFences(raw), 'function f() {\n\treturn 1;\n}');
	});

	test('modellen glömde avslutande staket', () => {
		assert.strictEqual(stripCodeFences('```python\nx = 1\n'), 'x = 1');
	});

	test('ren kod utan staket lämnas orörd', () => {
		assert.strictEqual(stripCodeFences('const x = 1;'), 'const x = 1;');
	});

	test('KRITISKT: ```-rader INNE i koden överlever', () => {
		// Kod som själv innehåller en markdown-sträng. Att klippa på sista
		// ``` var frestande men hade ätit upp halva funktionen.
		const raw = [
			'```ts',
			'const doc = "```js\\nfoo()\\n```";',
			'export default doc;',
			'```',
		].join('\n');
		assert.strictEqual(
			stripCodeFences(raw),
			'const doc = "```js\\nfoo()\\n```";\nexport default doc;'
		);
	});

	test('inledande och avslutande blanksteg trimmas bort', () => {
		assert.strictEqual(stripCodeFences('\n\n```ts\nconst x = 1;\n```\n\n'), 'const x = 1;');
	});

	test('en rad som bara börjar med backticks är inget staket', () => {
		// "```foo bar" är inte ett giltigt öppningsstaket (mellanslag i infon).
		const raw = '```foo bar\nnot code\n```';
		assert.strictEqual(stripCodeFences(raw), raw.trim());
	});

	test('fyra backticks räknas också som staket', () => {
		assert.strictEqual(stripCodeFences('````ts\nconst x = 1;\n````'), 'const x = 1;');
	});

	test('tomt svar och bara staket kraschar inte', () => {
		assert.strictEqual(stripCodeFences(''), '');
		assert.strictEqual(stripCodeFences('```'), '');
		assert.strictEqual(stripCodeFences('   '), '');
	});

	test('prosa runt ett block rörs inte -- det är inte ett kodsvar', () => {
		// Bara svar som BÖRJAR med ett staket behandlas som inramad kod.
		// Ett svar med förklaring först är inte kod och ska inte klippas isär.
		const raw = 'Here you go:\n```ts\nconst x = 1;\n```';
		assert.strictEqual(stripCodeFences(raw), raw);
	});
});

suite('Instruct: indenteringen tillbaka', () => {

	// Modellen svarar pa kolumn noll aven nar fragmentet den fick var
	// indenterat. Uppmatt, inte befarat: en markerad metodkropp kom tillbaka
	// utan sin indentering, och att skriva in den rakt av hade platt-tryckt
	// filen.

	test('gemensam indentering hoppar over rad 0', () => {
		// Rad 0 i en markering borjar oftast vid forsta TECKNET, inte vid
		// radens borjan -- dess "indentering" ar tom och skulle dra ner
		// namnaren till noll for hela blocket.
		const text = 'function f() {\n    return 1;\n    // done\n}';
		assert.strictEqual(commonIndent(text), '');
		const body = 'return 1;\n    const x = 2;\n    return x;';
		assert.strictEqual(commonIndent(body), '    ');
	});

	test('gemensam indentering ar den KORTASTE, inte den forsta', () => {
		assert.strictEqual(commonIndent('a\n\t\tdjupt\n\tgrunt'), '\t');
	});

	test('REFERENSFALL: 3B svarade pa kolumn noll', () => {
		// Ordagrant format fran modellen for en markering som lag tva
		// mellanslag in.
		const proposed = 'function getUsers(ids: number[]) {\n  return ids.map(id => db.find(id));\n}';
		const out = reindent(proposed, '  ', true);
		assert.strictEqual(
			out,
			'  function getUsers(ids: number[]) {\n    return ids.map(id => db.find(id));\n  }'
		);
	});

	test('markering som borjar mitt pa en rad far INTE indentering pa rad 0', () => {
		// Indenteringen star redan kvar i dokumentet fore markeringen.
		const out = reindent('foo();\nbar();', '    ', false);
		assert.strictEqual(out, 'foo();\n    bar();');
	});

	test('tomma rader bar inga blanktecken', () => {
		const out = reindent('a();\n\nb();', '  ', true);
		assert.strictEqual(out, '  a();\n\n  b();');
	});

	test('modellens egen indentering rensas innan var laggs pa', () => {
		// Annars adderas de tva och koden glider at hoger for varje omgang.
		const proposed = 'if (x) {\n    doThing();\n}';
		assert.strictEqual(reindent(proposed, '\t', true), '\tif (x) {\n\t    doThing();\n\t}');
	});

	test('tom indentering lamnar koden som den ar', () => {
		const code = 'const x = 1;\nconst y = 2;';
		assert.strictEqual(reindent(code, '', true), code);
	});

	test('en enda rad', () => {
		assert.strictEqual(reindent('return 1;', '    ', true), '    return 1;');
		assert.strictEqual(reindent('return 1;', '    ', false), 'return 1;');
	});
});

suite('Instruct: kontextklippning', () => {

	test('text under taket lämnas orörd', () => {
		assert.strictEqual(clampToLines('a\nb\nc', 100), 'a\nb\nc');
	});

	test('klipper på radgräns, inte mitt i en rad', () => {
		const text = 'rad ett\nrad tva\nrad tre\nrad fyra';
		const out = clampToLines(text, 20);
		assert.ok(out.length <= 20);
		assert.ok(text.startsWith(out));
		// Det klippta ska sluta på en hel rad.
		assert.ok(!out.endsWith(' '), 'slutade mitt i en rad');
		assert.strictEqual(out, 'rad ett\nrad tva');
	});

	test('en enda lång rad klipps på tecken hellre än att bli tom', () => {
		const text = 'x'.repeat(500);
		assert.strictEqual(clampToLines(text, 100).length, 100);
	});
});

suite('Instruct: cachenyckel per symbol', () => {

	test('samma symbol och kontext ger samma nyckel', () => {
		assert.strictEqual(cacheKey('handle', 'file.ts:12'), cacheKey('handle', 'file.ts:12'));
	});

	test('KRITISKT: samma symbol i olika kontext ger OLIKA nycklar', () => {
		// Utan kontexten i nyckeln hade `handle` i två filer delat förklaring,
		// och användaren hade fått grannens svar.
		assert.notStrictEqual(cacheKey('handle', 'a.ts'), cacheKey('handle', 'b.ts'));
	});

	test('olika symbol i samma kontext ger olika nycklar', () => {
		assert.notStrictEqual(cacheKey('foo', 'a.ts'), cacheKey('bar', 'a.ts'));
	});

	test('delarna kan inte glida ihop till samma nyckel', () => {
		// "ab" + "c" och "a" + "bc" måste skilja sig, annars kolliderar
		// symbolnamn med kontext.
		assert.notStrictEqual(cacheKey('ab', 'c'), cacheKey('a', 'bc'));
	});

	test('nyckeln är kort och filnamnsvänlig', () => {
		const key = cacheKey('someVeryLongSymbolName', 'x'.repeat(4000));
		assert.ok(key.length < 24, `nyckeln var ${key.length} tecken`);
		assert.ok(/^[a-z0-9-]+$/.test(key), `oväntade tecken i ${key}`);
	});
});

suite('Instruct: listan ur ett svar', () => {

	// Modellen ombes svara med ett namn per rad och gor det OFTAST. "Oftast" ar
	// problemet: numrering, bakatcitat och forklaringar efter ett bindestreck
	// maste bort innan namnet kan sattas in i koden.

	test('ren lista, en per rad', () => {
		assert.deepStrictEqual(parseList('userCount\ntotalUsers\nactiveUsers'), [
			'userCount', 'totalUsers', 'activeUsers',
		]);
	});

	test('numrering och punkter tas bort', () => {
		const raw = '1. userCount\n2) totalUsers\n- activeUsers\n* pendingUsers';
		assert.deepStrictEqual(parseList(raw, 8, isIdentifier), [
			'userCount', 'totalUsers', 'activeUsers', 'pendingUsers',
		]);
	});

	test('bakatcitat och citattecken tas bort', () => {
		assert.deepStrictEqual(parseList('`userCount`\n"totalUsers"', 8, isIdentifier), [
			'userCount', 'totalUsers',
		]);
	});

	test('KRITISKT: forklaringen efter namnet klipps bort', () => {
		// Utan det har hade "userCount - the number of users" blivit ett
		// variabelnamn med mellanslag i.
		const raw = 'userCount - the number of users\ntotalUsers: everyone';
		assert.deepStrictEqual(parseList(raw, 8, isIdentifier), ['userCount', 'totalUsers']);
	});

	test('prosarader som inte ar identifierare slapps', () => {
		const raw = 'Here are five names:\nuserCount\nI hope these help!';
		assert.deepStrictEqual(parseList(raw, 8, isIdentifier), ['userCount']);
	});

	test('dubbletter raknas en gang', () => {
		assert.deepStrictEqual(parseList('a\nb\na', 8, isIdentifier), ['a', 'b']);
	});

	test('taket haller', () => {
		assert.strictEqual(parseList('a\nb\nc\nd\ne', 3, isIdentifier).length, 3);
	});

	test('tomt svar ger tom lista', () => {
		assert.deepStrictEqual(parseList('', 5, isIdentifier), []);
		assert.deepStrictEqual(parseList('\n\n  \n', 5, isIdentifier), []);
	});

	test('identifierarkontrollen', () => {
		assert.ok(isIdentifier('userCount'));
		assert.ok(isIdentifier('_private'));
		assert.ok(isIdentifier('$el'));
		assert.ok(!isIdentifier('user count'));
		assert.ok(!isIdentifier('2fast'));
		assert.ok(!isIdentifier('user-count'));
		assert.ok(!isIdentifier(''));
		assert.ok(!isIdentifier('a'.repeat(60)), 'orimligt langt namn');
	});
});

suite('Instruct: lanen tool-parsar aldrig', () => {

	/** Modulens källkod MED kommentarerna borttagna -- vi granskar kod, inte prosa. */
	function instructCode(): string {
		// Kompilerad: out/test/ -> ../instructModel.js. Källa: ../../src/*.ts.
		const candidates = [
			path.join(__dirname, '..', 'instructModel.js'),
			path.join(__dirname, '..', '..', 'src', 'instructModel.ts'),
		];
		const file = candidates.find(f => fs.existsSync(f));
		if (!file) {
			throw new Error(`hittade inte instructModel; letade i:\n  ${candidates.join('\n  ')}`);
		}
		return fs.readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')  // blockkommentarer
			.replace(/^[ \t]*\/\/.*$/gm, '');  // radkommentarer
	}

	test('skickar inget tools-fält i request-bodyn', () => {
		assert.ok(
			!/\btools\b/.test(instructCode()),
			'instructModel nämner tools i kod -- instruct-lanen ska aldrig ha verktyg'
		);
	});

	test('rör aldrig verktygsanrop i svaret', () => {
		const code = instructCode();
		for (const forbidden of ['tool_calls', 'tool_use', 'tool_call', 'function_call', 'parseFallbackToolCalls']) {
			assert.ok(
				!code.includes(forbidden),
				`instructModel rör ${forbidden} -- svaret ska bara läsas som text`
			);
		}
	});

	test('importerar ingenting ur agent-/verktygskärnan', () => {
		assert.ok(
			!/from\s+["'][^"']*core\/(tools|agent)/.test(instructCode()),
			'instructModel importerar agent-loopen eller verktygsschemat'
		);
	});

	test('bara message.content plockas ur svaret', () => {
		assert.ok(
			instructCode().includes('choices?.[0]?.message?.content'),
			'svarsplockningen ser inte ut som förväntat -- kontrollera att den fortfarande bara läser text'
		);
	});
});
