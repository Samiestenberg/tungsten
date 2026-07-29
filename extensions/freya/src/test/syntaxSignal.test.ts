/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester for gransen mellan de tva stegen i felsokningen.
//
// Det har ar den viktigaste gransen i hela bygget, for den avgor VILKEN MODELL
// ett fel gar till -- och bada felen ar dyra:
//
//   Syntaxfel som skickas till 3B:  anvandaren vantar ~2 s pa nagot parsern
//                                   redan visste exakt.
//   Semantiskt fel som skickas till 1.5B:  ett sjalvsakert nonsenssvar, for
//                                   modellen kan inte resonera om typer.
//
// TS-koderna ar den palitliga signalen (1xxx = parser, 2xxx = typkontroll).
// Frasmonstren finns for allt annat, och de semantiska undantagen finns for
// att flera typfel LATER syntaktiska i sin formulering.

import 'mocha';
import * as assert from 'assert';
import { isSyntaxDiagnostic, isUsefulGap, sanitizeGap } from '../fim/syntaxSignal.js';

suite('Tvastegsfelsokning: TS-koder avgor', () => {

	test('1xxx ar parserfel -> 1.5B', () => {
		assert.ok(isSyntaxDiagnostic("',' expected.", 1005));
		assert.ok(isSyntaxDiagnostic("'}' expected.", 1005));
		assert.ok(isSyntaxDiagnostic('Declaration or statement expected.', 1128));
	});

	test('2xxx ar typkontrollen -> 3B', () => {
		assert.ok(!isSyntaxDiagnostic("Property 'x' does not exist on type 'Y'.", 2339));
		assert.ok(!isSyntaxDiagnostic("Type 'string' is not assignable to type 'number'.", 2322));
		assert.ok(!isSyntaxDiagnostic("Cannot find name 'foo'.", 2304));
	});

	test('koden vinner over texten', () => {
		// Ett 2xxx-fel som RADE formuleras med "expected" ar anda semantiskt.
		assert.ok(!isSyntaxDiagnostic('Expected 1 arguments, but got 2.', 2554));
		// ... och ett 1xxx-fel utan nagot av nyckelorden ar anda syntaktiskt.
		assert.ok(isSyntaxDiagnostic('Unterminated string literal.', 1002));
	});

	test('koden accepteras bade som tal och som TS-strang', () => {
		assert.strictEqual(isSyntaxDiagnostic("',' expected.", 'TS1005'), true);
		assert.strictEqual(isSyntaxDiagnostic("',' expected.", '1005'), true);
	});
});

suite('Tvastegsfelsokning: utan kod avgor texten', () => {

	test('parserformuleringar utan kod -> 1.5B', () => {
		assert.ok(isSyntaxDiagnostic('SyntaxError: invalid syntax'));
		assert.ok(isSyntaxDiagnostic('Unexpected token )'));
		assert.ok(isSyntaxDiagnostic('Parsing error: Unexpected token'));
		assert.ok(isSyntaxDiagnostic('unclosed delimiter'));
		assert.ok(isSyntaxDiagnostic('missing closing parenthesis'));
	});

	test('KRITISKT: typfel som later syntaktiska -> 3B anda', () => {
		// De har innehaller nyckelord ur syntaxfamiljen men ar semantik.
		assert.ok(!isSyntaxDiagnostic("Property 'name' does not exist on type 'User'."));
		assert.ok(!isSyntaxDiagnostic("Type 'X' is not assignable to type 'Y'."));
		assert.ok(!isSyntaxDiagnostic("Module '\"./a\"' has no exported member 'b'."));
		assert.ok(!isSyntaxDiagnostic("Cannot find module './missing'."));
		assert.ok(!isSyntaxDiagnostic("Parameter 'x' implicitly has an 'any' type."));
		assert.ok(!isSyntaxDiagnostic("'x' is declared but its value is never read."));
		assert.ok(!isSyntaxDiagnostic("Object is possibly 'undefined'."));
		assert.ok(!isSyntaxDiagnostic('No overload matches this call.'));
	});

	test('vanlig prosa ar varken det ena eller det andra', () => {
		assert.ok(!isSyntaxDiagnostic('Prefer const over let.'));
		assert.ok(!isSyntaxDiagnostic(''));
	});
});

suite('Tvastegsfelsokning: luckan som visas', () => {

	test('en kort lucka slapps igenom', () => {
		assert.strictEqual(sanitizeGap('}'), '}');
		assert.strictEqual(sanitizeGap(');'), ');');
	});

	test('bara forsta raden -- en lucka ar inte en ny kropp', () => {
		assert.strictEqual(sanitizeGap('}\nfunction next() {\n  return 1;\n}'), '}');
	});

	test('inledande blanktecken hor inte hemma mitt i en rad', () => {
		assert.strictEqual(sanitizeGap('   );'), ');');
	});

	test('KRITISKT: ett langt svar ar ingen lucka och kastas', () => {
		// Modellen skrev en omskrivning ingen bad om. Battre inget forslag.
		const long = 'const result = items.filter(Boolean).map(x => x.value).join(", ");';
		assert.strictEqual(sanitizeGap(long), '');
	});

	test('taket gar att flytta for den som vill', () => {
		assert.strictEqual(sanitizeGap('abcdefghij', 5), '');
		assert.strictEqual(sanitizeGap('abcde', 5), 'abcde');
	});

	test('tomma och blanka gissningar visas inte', () => {
		assert.ok(!isUsefulGap(''));
		assert.ok(!isUsefulGap('   '));
		assert.ok(!isUsefulGap('\t'));
		assert.ok(isUsefulGap('}'));
	});
});
