/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// TOKENBUDGETEN: att vi inte lovar workbenchen mer an modellen kan ta emot.
//
// ─────────────────────────────────────────────────────────────────────────
// VAD SOM FAKTISKT HANDE FORE FIXEN -- uppmatt mot en riktig D2-installation
// med Granite-3B-Code-Instruct-2k:
//
//   annonserat  maxInputTokens 6000, maxOutputTokens 1000
//   verkligt    n_ctx_slot 2048  (llama-server kapar till traningskontexten)
//
//   POST /completion, 5601 tokens prompt  ->  HTTP 400
//   {"error":{"message":"request (5601 tokens) exceeds the available context
//     size (2048 tokens)","type":"exceed_context_size_error"}}
//
// 5601 lag UNDER 6000. Workbenchen trimmade alltsa till ett tal den trodde var
// lagligt och fick ett HART fel tillbaka i stallet for ett svar. Foljden var
// inte avhuggna svar utan inga svar alls.
//
// Talen ar darfor inte langre konstanter utan raknas bakat fran kontexten. Det
// har testet holler ihop den rakningen: summan av allt vi lovar plus allt vi
// lagger till sjalva maste rymmas i kontexten, med marginal.
// ─────────────────────────────────────────────────────────────────────────

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';

const Module = require('module');
const OUT = path.join(__dirname, '..');

/** instructServer.js med ETT konfigurationsvarde satt. */
function serverWith(contextSize: unknown): any {
	const target = path.join(OUT, 'instructServer.js');
	const fakeVscode = {
		workspace: {
			getConfiguration: () => ({
				get: (k: string) => (k === 'instruct.contextSize' ? contextSize : undefined),
			}),
		},
		window: {
			createOutputChannel: () => ({
				info() { }, warn() { }, error() { }, trace() { }, dispose() { },
			}),
		},
		env: { appRoot: 'C:/nowhere', machineId: 'test' },
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

suite('Instruct-budget: vi lovar inte mer an som ryms', () => {

	test('standardkontexten ar 2048 -- modellens traningskontext, inte 8192', () => {
		// 8192 var inte bara optimistiskt utan OUPPNAELIGT: llama-server kapar
		// till n_ctx_train. Uppmatt med bade --ctx-size 8192 och --ctx-size 2048
		// mot samma modell och samma binar: n_ctx_slot blev 2048 i bada fallen.
		assert.strictEqual(serverWith(undefined).instructContextSize(), 2048);
	});

	test('ett hogre varde respekteras -- for den som byter modell', () => {
		assert.strictEqual(serverWith(8192).instructContextSize(), 8192);
	});

	test('skrap i settings.json faller tillbaka pa 2048', () => {
		for (const junk of ['2048', 0, -1, 12.5, null, {}]) {
			assert.strictEqual(
				serverWith(junk).instructContextSize(),
				2048,
				`${JSON.stringify(junk)} borde ha gett standardvardet`
			);
		}
	});

	test('KRITISKT: indata + utdata + guide-prompten ryms i kontexten', () => {
		// Det har ar hela poangen. maxInputTokens tacker BARA meddelandena --
		// GUIDE_SYSTEM och GUIDE_SHOTS laggs pa EFTER att workbenchen trimmat,
		// och genereringen ska ocksa rymmas i samma fonster. Ett tal som bara
		// tar hansyn till meddelandena blir for stort aven nar det ser
		// forsiktigt ut, och det var precis sa 6000 kunde sta bredvid 2048.
		for (const ctx of [2048, 4096, 8192, 32768]) {
			const mod = serverWith(ctx);
			const total = mod.instructMaxInputTokens() + mod.INSTRUCT_MAX_OUTPUT_TOKENS;
			assert.ok(
				total < ctx,
				`kontext ${ctx}: lovar ${total} tokens, vilket inte ryms`
			);
			// Marginalen ska rymma guide-prompten (uppmatt 368 tokens) plus
			// slack for att vår tokenuppskattare ar en gissning.
			assert.ok(
				ctx - total >= 400,
				`kontext ${ctx}: bara ${ctx - total} tokens kvar till guide-prompten`
			);
		}
	});

	test('med den modell vi faktiskt skickar blir det 868 in / 600 ut', () => {
		// Talet star har for att en andring av nagon av de tre avdragen ska
		// synas som ett fallande test och inte tyst forandra vad chatten lovar.
		const mod = serverWith(undefined);
		assert.strictEqual(mod.instructMaxInputTokens(), 868);
		assert.strictEqual(mod.INSTRUCT_MAX_OUTPUT_TOKENS, 600);
	});

	test('en absurt liten kontext ger anda ett anvandbart golv', () => {
		// Ingen ska kunna konfigurera fram ett negativt maxInputTokens.
		assert.ok(serverWith(512).instructMaxInputTokens() >= 256);
	});
});
