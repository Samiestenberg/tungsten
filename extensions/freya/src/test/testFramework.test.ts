/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester for ramverksdetekteringen (testFramework.ts).
//
// Ett genererat test i FEL ramverk ar vardelost pa ett sarskilt irriterande
// satt: det ser ratt ut, det kors inte, och felet syns forst nar man kor
// suiten. Repot vet redan svaret, sa detekteringen ar det som avgor om
// funktionen ar anvandbar eller bara ser anvandbar ut.

import 'mocha';
import * as assert from 'assert';
import {
	FALLBACK_FRAMEWORK,
	frameworkFromLanguage,
	frameworkFromPackageJson,
	mochaUi,
	testPathFor,
} from '../testFramework.js';

suite('Testramverk: ur package.json', () => {

	test('vitest i devDependencies', () => {
		const pkg = { devDependencies: { vitest: '^1.0.0' } };
		assert.strictEqual(frameworkFromPackageJson(pkg)?.name, 'Vitest');
	});

	test('jest i dependencies raknas ocksa', () => {
		assert.strictEqual(frameworkFromPackageJson({ dependencies: { jest: '29' } })?.name, 'Jest');
	});

	test('mocha', () => {
		const found = frameworkFromPackageJson({ devDependencies: { mocha: '10' } });
		assert.ok(found?.name.startsWith('Mocha'));
	});

	test('prioritetsordning nar flera finns', () => {
		// Ett projekt kan ha bade jest och mocha i tradet. Vitest vinner, sedan
		// jest, sedan mocha -- deterministiskt i stallet for slumpmassigt.
		const pkg = { devDependencies: { mocha: '10', jest: '29', vitest: '1' } };
		assert.strictEqual(frameworkFromPackageJson(pkg)?.name, 'Vitest');
		const noVitest = { devDependencies: { mocha: '10', jest: '29' } };
		assert.strictEqual(frameworkFromPackageJson(noVitest)?.name, 'Jest');
	});

	test('node --test syns bara i test-skriptet', () => {
		// Nodes egen testkorare kraver inget beroende, sa det finns inget
		// paketnamn att leta efter.
		const pkg = { scripts: { test: 'node --test ./out/**/*.test.js' } };
		assert.strictEqual(frameworkFromPackageJson(pkg)?.name, 'node:test');
	});

	test('projekt utan testramverk ger undefined', () => {
		assert.strictEqual(frameworkFromPackageJson({ dependencies: { react: '18' } }), undefined);
		assert.strictEqual(frameworkFromPackageJson({}), undefined);
	});

	test('skrap in kraschar inte', () => {
		assert.strictEqual(frameworkFromPackageJson(undefined), undefined);
		assert.strictEqual(frameworkFromPackageJson(null), undefined);
		assert.strictEqual(frameworkFromPackageJson('inte ett objekt'), undefined);
		assert.strictEqual(frameworkFromPackageJson(42), undefined);
	});
});

suite('Testramverk: mochas ui', () => {

	test('tdd ur test-skriptet', () => {
		// Det har repot kor sjalvt tdd (suite/test). Skillnaden syns inte i
		// beroendena utan i hur mocha startas.
		const pkg = { scripts: { test: 'mocha --ui tdd out/**/*.test.js' } };
		assert.ok(mochaUi(pkg).name.includes('tdd'));
	});

	test('tdd ur .mocharc', () => {
		assert.ok(mochaUi({}, '{ "ui": "tdd" }').name.includes('tdd'));
	});

	test('tdd ur mocha-blocket i package.json', () => {
		assert.ok(mochaUi({ mocha: { ui: 'tdd' } }).name.includes('tdd'));
	});

	test('utan besked antas bdd', () => {
		assert.ok(mochaUi({ scripts: { test: 'mocha' } }).name.includes('bdd'));
	});
});

suite('Testramverk: ur spraket', () => {

	test('sprak med inbyggd testkorning', () => {
		assert.strictEqual(frameworkFromLanguage('python')?.name, 'pytest');
		assert.strictEqual(frameworkFromLanguage('go')?.name, 'go test');
		assert.strictEqual(frameworkFromLanguage('rust')?.name, 'cargo test');
	});

	test('typescript sager inget i sig sjalvt', () => {
		assert.strictEqual(frameworkFromLanguage('typescript'), undefined);
	});

	test('sista utvagen ar vitest', () => {
		assert.strictEqual(FALLBACK_FRAMEWORK.name, 'Vitest');
	});
});

suite('Testramverk: var testfilen hor hemma', () => {

	const vitest = frameworkFromPackageJson({ devDependencies: { vitest: '1' } })!;
	const pytest = frameworkFromLanguage('python')!;
	const gotest = frameworkFromLanguage('go')!;

	test('js/ts: bredvid kallfilen', () => {
		assert.strictEqual(testPathFor('src/cart.ts', vitest), 'src/cart.test.ts');
	});

	test('KRITISKT: .tsx ger .test.tsx, inte .test.ts', () => {
		// En komponentfil som testas i en .ts-fil kompilerar inte.
		assert.strictEqual(testPathFor('src/Button.tsx', vitest), 'src/Button.test.tsx');
		assert.strictEqual(testPathFor('src/util.mjs', vitest), 'src/util.test.mjs');
	});

	test('go kraver _test.go i samma mapp', () => {
		assert.strictEqual(testPathFor('pkg/cart.go', gotest), 'pkg/cart_test.go');
	});

	test('pytest vill ha test_-prefix', () => {
		assert.strictEqual(testPathFor('app/cart.py', pytest), 'app/test_cart.py');
	});

	test('windows-sokvagar normaliseras', () => {
		assert.strictEqual(testPathFor('src\\lib\\cart.ts', vitest), 'src/lib/cart.test.ts');
	});

	test('fil utan mapp', () => {
		assert.strictEqual(testPathFor('cart.ts', vitest), 'cart.test.ts');
	});

	test('okand andelse faller tillbaka pa .ts', () => {
		assert.strictEqual(testPathFor('src/thing.vue', vitest), 'src/thing.test.ts');
	});
});
