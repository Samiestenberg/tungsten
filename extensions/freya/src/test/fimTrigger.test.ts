/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester for FIM-prompthens konstruktion: vad markoren star i, och vad det
// betyder for anropet.
//
// Det har ar den dyraste delen att ha fel i. Ett felklassat lage kostar inte
// ett dumt forslag utan en dum VANTAN: block-laget har fyra ganger
// tokenbudgeten, sa ett block som utloses mitt i en rad ar ~2,5 sekunder
// innan anvandaren far nagot alls. Darfor ar kontrollfallen har fler an
// traffallen.

import 'mocha';
import * as assert from 'assert';
import {
	BLOCK_TOKEN_CAP,
	classifyFimTrigger,
	currentLinePrefix,
	EXPRESSION_TOKEN_CAP,
	indentOf,
	inSignature,
	INLINE_TOKEN_CAP,
	opensBlock,
	previousNonEmptyLine,
	trimToBlock,
	unclosedParens,
} from '../fim/fimTrigger.js';

/** Bygger ett prefix dar markoren star sist. | i indata betyder inget speciellt. */
function prefixOf(...lines: string[]): string {
	return lines.join('\n');
}

suite('FIM: prefixet runt markoren', () => {

	test('markorens rad ar allt efter sista radbrytningen', () => {
		assert.strictEqual(currentLinePrefix('a\nb\n  const x = '), '  const x = ');
	});

	test('ett prefix utan radbrytning ar hela raden', () => {
		assert.strictEqual(currentLinePrefix('const x = '), 'const x = ');
	});

	test('markoren pa en tom rad ger tom rad', () => {
		assert.strictEqual(currentLinePrefix('function f() {\n'), '');
	});

	test('indentering plockas ut, bade mellanslag och tabb', () => {
		assert.strictEqual(indentOf('    foo()'), '    ');
		assert.strictEqual(indentOf('\t\tfoo()'), '\t\t');
		assert.strictEqual(indentOf('foo()'), '');
	});

	test('foregaende icke-tomma rad hoppar over blankrader', () => {
		assert.strictEqual(previousNonEmptyLine('function f() {\n\n\n  '), 'function f() {');
	});

	test('inget fore markoren ger tom strang i stallet for krasch', () => {
		assert.strictEqual(previousNonEmptyLine('  '), '');
	});
});

suite('FIM: oppnar raden en kropp', () => {

	test('klammersprak: rad som slutar pa {', () => {
		assert.ok(opensBlock('function f() {', 'typescript'));
		assert.ok(opensBlock('  if (x) {', 'javascript'));
		assert.ok(opensBlock('impl Foo {', 'rust'));
	});

	test('klammersprak: bara nyckelord utan klammer', () => {
		assert.ok(opensBlock('  } else', 'typescript'));
		assert.ok(opensBlock('  try', 'java'));
	});

	test('indenteringssprak: rad som slutar pa :', () => {
		assert.ok(opensBlock('def f(a):', 'python'));
		assert.ok(opensBlock('  for x in xs:', 'python'));
	});

	test('KONTROLLFALL: en { i en kommentar oppnar ingenting', () => {
		assert.ok(!opensBlock('// har borjar blocket {', 'typescript'));
		assert.ok(!opensBlock('# python-kommentar:', 'python'));
	});

	test('KONTROLLFALL: ett : i typescript ar inte ett block', () => {
		// Det ar en typannotering, inte en kropp.
		assert.ok(!opensBlock('  name:', 'typescript'));
	});

	test('KONTROLLFALL: en vanlig sats oppnar ingenting', () => {
		assert.ok(!opensBlock('  const x = 1;', 'typescript'));
		assert.ok(!opensBlock('  return x', 'python'));
	});

	test('KONTROLLFALL: okant sprak gissar inte pa block', () => {
		// Ett felaktigt blockforslag kostar 2,5 s och ger nonsens.
		assert.ok(!opensBlock('something {', 'plaintext'));
	});

	test('KONTROLLFALL: tom rad', () => {
		assert.ok(!opensBlock('', 'typescript'));
		assert.ok(!opensBlock('   ', 'typescript'));
	});
});

suite('FIM: klassificeringen', () => {

	test('tom rad efter { -> BLOCK', () => {
		const plan = classifyFimTrigger(prefixOf('function add(a, b) {', '  '), 'typescript', 256);
		assert.strictEqual(plan.kind, 'block');
		assert.strictEqual(plan.multiline, true);
		assert.strictEqual(plan.maxTokens, BLOCK_TOKEN_CAP);
		assert.deepStrictEqual(plan.stop, [], 'block-laget far inte ha radstopp');
	});

	test('tom rad efter def ...: -> BLOCK', () => {
		const plan = classifyFimTrigger(prefixOf('def add(a, b):', '    '), 'python', 256);
		assert.strictEqual(plan.kind, 'block');
	});

	test('KRITISKT: blocket klipps mot OPPNARENS indentering', () => {
		// Kroppen ligger en niva IN. Klipper vi mot markorens indentering
		// slutar blocket direkt pa forsta raden.
		const plan = classifyFimTrigger(prefixOf('  function f() {', '    '), 'typescript', 256);
		assert.strictEqual(plan.baseIndent, '  ');
	});

	test('mitt i en rad -> LINE', () => {
		const plan = classifyFimTrigger(prefixOf('function f() {', '  const x = '), 'typescript', 256);
		assert.strictEqual(plan.kind, 'line');
		assert.strictEqual(plan.multiline, false);
		assert.deepStrictEqual(plan.stop, ['\n']);
	});

	test('KONTROLLFALL: tom rad som INTE foljer pa en oppnad kropp -> LINE', () => {
		const plan = classifyFimTrigger(prefixOf('const a = 1;', ''), 'typescript', 256);
		assert.strictEqual(plan.kind, 'line');
	});

	test('radtaket ar ett TAK, inte en ny default', () => {
		// Den som sanker autocomplete.maxTokens ska fa ett kortare forslag.
		assert.strictEqual(classifyFimTrigger('const x = ', 'typescript', 8).maxTokens, 8);
		assert.strictEqual(classifyFimTrigger('const x = ', 'typescript', 256).maxTokens, INLINE_TOKEN_CAP);
	});

	test('tomt prefix kraschar inte', () => {
		assert.strictEqual(classifyFimTrigger('', 'typescript', 256).kind, 'line');
	});
});

suite('FIM: return-uttryck', () => {

	test('ensamt return pa raden -> RETURN', () => {
		const plan = classifyFimTrigger(prefixOf('function f(xs) {', '  const n = xs.length;', '  return'), 'typescript', 256);
		assert.strictEqual(plan.kind, 'return');
		assert.strictEqual(plan.multiline, false);
		assert.strictEqual(plan.maxTokens, EXPRESSION_TOKEN_CAP);
		assert.deepStrictEqual(plan.stop, ['\n']);
	});

	test('return med efterfoljande mellanslag raknas ocksa', () => {
		assert.strictEqual(classifyFimTrigger('  return ', 'python', 256).kind, 'return');
	});

	test('KRITISKT: return vinner over block', () => {
		// Ett ensamt return pa forsta raden i en nyoppnad kropp ar ETT uttryck,
		// inte en hel kropp. Utan prioriteringen hade det kostat 96 tokens.
		const plan = classifyFimTrigger(prefixOf('function f() {', '  return'), 'typescript', 256);
		assert.strictEqual(plan.kind, 'return');
	});

	test('KONTROLLFALL: return som redan har ett uttryck ar en vanlig rad', () => {
		assert.strictEqual(classifyFimTrigger('  return a +', 'typescript', 256).kind, 'line');
	});

	test('KONTROLLFALL: ett ord som borjar pa return ar inte return', () => {
		assert.strictEqual(classifyFimTrigger('  returnValue', 'typescript', 256).kind, 'line');
	});
});

suite('FIM: typsignaturer', () => {

	test('parenteser raknas utanfor strangar', () => {
		assert.strictEqual(unclosedParens('function f(a, b'), 1);
		assert.strictEqual(unclosedParens('function f(a, b)'), 0);
		assert.strictEqual(unclosedParens('foo(bar(baz'), 2);
	});

	test('KRITISKT: parenteser i en strang raknas inte', () => {
		// Utan strangmedvetenheten hade `log("(")` sett ut som en oppen
		// parameterlista och utlost typgissningar mitt i koden.
		assert.strictEqual(unclosedParens('log("(")'), 0);
		assert.strictEqual(unclosedParens("const s = '(';"), 0);
	});

	test('escape i en strang forvirrar inte raknaren', () => {
		assert.strictEqual(unclosedParens('const s = "a\\"(";'), 0);
	});

	test('inne i parameterlistan -> signatur', () => {
		assert.ok(inSignature('function add(a', 'typescript'));
		assert.ok(inSignature('  def add(self, a', 'python'));
		assert.ok(inSignature('fn add(a: i32, b', 'rust'));
	});

	test('direkt efter parameterlistan -> returtypens plats', () => {
		assert.ok(inSignature('function add(a: number, b: number)', 'typescript'));
		assert.ok(inSignature('  def add(self, a, b)', 'python'));
	});

	test('KONTROLLFALL: javascript har inga typer att gissa', () => {
		assert.ok(!inSignature('function add(a', 'javascript'));
		assert.ok(!inSignature('function add(a, b)', 'javascriptreact'));
	});

	test('KONTROLLFALL: ett vanligt funktionsANROP ar ingen signatur', () => {
		// Det har ar det dyra falset: varje foo( i en kropp skulle annars
		// utlosa typgissningar.
		assert.ok(!inSignature('  const total = calculateSum(items', 'typescript'));
		assert.ok(!inSignature('  console.log(x', 'typescript'));
	});

	test('KONTROLLFALL: kroppen har redan borjat', () => {
		// { eller : efter parenteserna betyder att signaturen ar fardig.
		assert.ok(!inSignature('function add(a: number): number {', 'typescript'));
		assert.ok(!inSignature('def add(a, b):', 'python'));
	});

	test('signaturplanen stoppar innan kroppen', () => {
		const plan = classifyFimTrigger('function add(a', 'typescript', 256);
		assert.strictEqual(plan.kind, 'signature');
		assert.ok(plan.stop.includes('{'), 'maste stoppa pa { -- vi fyller signaturen, inte funktionen');
		assert.ok(plan.stop.includes('\n'));
		assert.strictEqual(plan.maxTokens, EXPRESSION_TOKEN_CAP);
	});
});

suite('FIM: klipp blocket dar det tar slut', () => {

	test('behaller kroppen och den stangande klammern', () => {
		const completion = [
			'  return a + b;',
			'}',
		].join('\n');
		assert.strictEqual(trimToBlock(completion, ''), '  return a + b;\n}');
	});

	test('KRITISKT: kastar det modellen skrev EFTER blocket', () => {
		// Utan radstopp fortsatter 1.5B:n garna och skriver nasta funktion.
		const completion = [
			'  return a + b;',
			'}',
			'',
			'function sub(a, b) {',
			'  return a - b;',
			'}',
		].join('\n');
		assert.strictEqual(trimToBlock(completion, ''), '  return a + b;\n}');
	});

	test('indenterat block klipps mot sin egen niva', () => {
		const completion = [
			'    this.count++;',
			'    return this.count;',
			'  }',
			'',
			'  other() {',
		].join('\n');
		assert.strictEqual(
			trimToBlock(completion, '  '),
			'    this.count++;\n    return this.count;\n  }'
		);
	});

	test('flera rader i kroppen overlever', () => {
		const completion = [
			'  const sum = a + b;',
			'  const avg = sum / 2;',
			'  return avg;',
			'}',
		].join('\n');
		assert.strictEqual(trimToBlock(completion, ''), completion);
	});

	test('forsta raden saknar indentering (markoren star dar) och behalls', () => {
		const completion = 'return a + b;\n}';
		assert.strictEqual(trimToBlock(completion, '  '), 'return a + b;\n}');
	});

	test('indenteringssprak: dedent avslutar blocket', () => {
		const completion = [
			'    return a + b',
			'',
			'def sub(a, b):',
			'    return a - b',
		].join('\n');
		// Ingen stangande klammer i python -- dedenten sjalv ar slutet.
		assert.strictEqual(trimToBlock(completion, ''), '    return a + b');
	});

	test('tomrader i slutet ar brus och tas bort', () => {
		assert.strictEqual(trimToBlock('  return 1;\n}\n\n\n', ''), '  return 1;\n}');
	});

	test('tomt forslag ger tomt tillbaka', () => {
		assert.strictEqual(trimToBlock('', ''), '');
	});
});
