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
	indentOf,
	INLINE_TOKEN_CAP,
	opensBlock,
	previousNonEmptyLine,
	trimToBlock,
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
