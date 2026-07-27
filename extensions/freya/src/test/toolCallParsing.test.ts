/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tester för återskapningen av verktygsanrop ur modelltext (Ollama-lanan).
//
// Referensfallen nedan är RIKTIGA svar från qwen2.5-coder:14b, fångade mot
// http://localhost:11434 innan fixen. Den gamla parsern klarade bara svar där
// HELA texten var JSON, så varje fall med prosa runt anropet föll igenom:
// verktyget kördes aldrig och JSON:en läckte ut i chatten som om den var svaret.

import 'mocha';
import * as assert from 'assert';
import { parseFallbackToolCalls } from '../core/providers/ollama.js';

// Samma sex verktyg som TOOL_SCHEMAS registrerar.
const TOOLS = new Set([
	'read_file',
	'write_file',
	'edit_file',
	'list_files',
	'search_files',
	'run_command',
]);

suite('Ollama: verktygsanrop ur text', () => {

	test('bart JSON-objekt (fungerade före fixen också)', () => {
		const calls = parseFallbackToolCalls('{"name": "list_files", "arguments": {}}', TOOLS);
		assert.deepStrictEqual(calls, [{ name: 'list_files', arguments: {} }]);
	});

	test('REFERENSFALL: ```json-block följt av prosa', () => {
		// Ordagrant svar från qwen2.5-coder:14b.
		const raw = [
			'```json',
			'{',
			'  "name": "list_files",',
			'  "arguments": {}',
			'}',
			'```',
			'',
			'Detta anrop listar alla filer och mappar i projektroten för att ge mig en',
			'överblick över projekts struktur.',
		].join('\n');

		const calls = parseFallbackToolCalls(raw, TOOLS);
		assert.deepStrictEqual(calls, [{ name: 'list_files', arguments: {} }]);
	});

	test('REFERENSFALL: prosa FÖRE anropet', () => {
		// Andra ordningen, också ordagrant från modellen. Här streamades prosan
		// ut innan JSON:en, så gaten i send() måste hålla tillbaka resten.
		const raw = [
			'För att förstå projektstrukturen och identifiera relevant kod eller',
			'innehåll, ska jag nu söka efter viktiga definitioner.',
			'',
			'```json',
			'{',
			'  "name": "search_files",',
			'  "arguments": {',
			'    "query": "function"',
			'  }',
			'}',
			'```',
		].join('\n');

		const calls = parseFallbackToolCalls(raw, TOOLS);
		assert.deepStrictEqual(calls, [
			{ name: 'search_files', arguments: { query: 'function' } },
		]);
	});

	test('REFERENSFALL: argument med värden, prosa efter', () => {
		const raw = [
			'```json',
			'{',
			'  "name": "list_files",',
			'  "arguments": {',
			'    "max_depth": 3,',
			'    "path": ""',
			'  }',
			'}',
			'```',
			'',
			'**Förklaring:**  ',
			'Jag listar filer i projektroten för att orientera mig.',
		].join('\n');

		const calls = parseFallbackToolCalls(raw, TOOLS);
		assert.deepStrictEqual(calls, [
			{ name: 'list_files', arguments: { max_depth: 3, path: '' } },
		]);
	});

	test('KONTROLLFALL: legitim JSON i ett kodsvar är inget anrop', () => {
		// "visa mig ett exempel på package.json" -- inget verktygsnamn i sikte.
		const raw = [
			'Här är ett minimalt exempel:',
			'',
			'```json',
			'{',
			'  "name": "mitt-paket",',
			'  "version": "1.0.0",',
			'  "scripts": { "build": "tsc" },',
			'  "dependencies": {}',
			'}',
			'```',
		].join('\n');

		assert.strictEqual(parseFallbackToolCalls(raw, TOOLS), null);
	});

	test('KONTROLLFALL: okänt verktygsnamn räknas inte', () => {
		const raw = '{"name": "rm_minus_rf", "arguments": {"path": "/"}}';
		assert.strictEqual(parseFallbackToolCalls(raw, TOOLS), null);
	});

	test('KONTROLLFALL: tom verktygslista stänger av återskapningen', () => {
		const raw = '{"name": "list_files", "arguments": {}}';
		assert.strictEqual(parseFallbackToolCalls(raw, new Set<string>()), null);
	});

	test('alias: "parameters" i stället för "arguments"', () => {
		const raw = 'Jag kollar filen.\n{"name": "read_file", "parameters": {"path": "a.js"}}';
		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'read_file', arguments: { path: 'a.js' } },
		]);
	});

	test('argument som JSON-sträng', () => {
		const raw = '{"name": "read_file", "arguments": "{\\"path\\": \\"b.js\\"}"}';
		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'read_file', arguments: { path: 'b.js' } },
		]);
	});

	test('OpenAI-formen {"function": {...}}', () => {
		const raw = 'ok\n{"type": "function", "function": {"name": "list_files", "arguments": {}}}';
		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'list_files', arguments: {} },
		]);
	});

	test('omslag ett steg ner: {"tool_call": {...}}', () => {
		const raw = '{"tool_call": {"name": "list_files", "arguments": {}}}';
		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'list_files', arguments: {} },
		]);
	});

	test('flera anrop, med prosa emellan', () => {
		const raw = [
			'Först listar jag filerna:',
			'{"name": "list_files", "arguments": {}}',
			'och sedan läser jag en av dem:',
			'{"name": "read_file", "arguments": {"path": "berakna.js"}}',
		].join('\n');

		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'list_files', arguments: {} },
			{ name: 'read_file', arguments: { path: 'berakna.js' } },
		]);
	});

	test('<tool_call>-taggar', () => {
		const raw = '<tool_call>\n{"name": "list_files", "arguments": {}}\n</tool_call>';
		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'list_files', arguments: {} },
		]);
	});

	test('klammer inne i en sträng förvirrar inte balanseringen', () => {
		const raw = '{"name": "write_file", "arguments": {"path": "x.json", "content": "{ \\"a\\": 1 }"}}';
		assert.deepStrictEqual(parseFallbackToolCalls(raw, TOOLS), [
			{ name: 'write_file', arguments: { path: 'x.json', content: '{ "a": 1 }' } },
		]);
	});

	test('trasiga argument ger inget anrop hellre än gissade argument', () => {
		const raw = '{"name": "read_file", "arguments": "inte json alls"}';
		assert.strictEqual(parseFallbackToolCalls(raw, TOOLS), null);
	});

	test('argument som array är inte giltiga argument', () => {
		const raw = '{"name": "read_file", "arguments": ["a.js"]}';
		assert.strictEqual(parseFallbackToolCalls(raw, TOOLS), null);
	});

	test('ren prosa utan JSON', () => {
		assert.strictEqual(
			parseFallbackToolCalls('Filerna i mappen är berakna.js och hej.txt.', TOOLS),
			null
		);
	});

	test('trasigt/oavslutat JSON kraschar inte', () => {
		assert.strictEqual(parseFallbackToolCalls('{"name": "list_files", "argum', TOOLS), null);
		assert.strictEqual(parseFallbackToolCalls('}{]{[', TOOLS), null);
	});

	test('anrop utan arguments-nyckel ger tomma argument', () => {
		assert.deepStrictEqual(parseFallbackToolCalls('{"name": "list_files"}', TOOLS), [
			{ name: 'list_files', arguments: {} },
		]);
	});
});
