/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// OMFÖRSÖKET I INSTRUCT-LANEN, testat på beteendet och inte på källkoden.
//
// ─────────────────────────────────────────────────────────────────────────
// BUGGEN SOM FIXEN LÖSER
//
// start() i instructServer.ts har en probeReady()-gren som gör att ett andra
// fönster ÅTERANVÄNDER en llama-server som redan kör i stället för att ladda
// 2 GB en gång till. Fönster B får då en endpoint till en process det inte
// äger: this.proc är undefined hos B, så B får inget "exit"-event när den dör.
//
// Fönster A äger processen och river den vid idle-unload (eller när A stängs).
// Efter det har B kvar en cachad endpoint som pekar på ingenting, och ensure()
// returnerar den rakt av -- `if (this.endpoint) return this.endpoint` -- utan
// att proba om. Varje instruct-anrop i B ger då ECONNREFUSED tills B:s EGEN
// idle-timer råkar lösa ut, eller för alltid om idleUnloadMs är 0.
//
// Fixen: kontaktfel släpper cachen och gör OM anropet en gång.
//
// VARFÖR TESTET SER UT SÅ HÄR: den riktiga reproduktionen kräver två fönster,
// en 2 GB-modell och en taskkill. Det som går att låsa fast billigt är
// BESLUTEN, och det är de som är lätta att råka ändra:
//
//   kontaktfel   -> släpp cachen, försök om EN gång
//   HTTP-fel     -> servern lever och sa nej; kasta vidare, ingen retry
//   avbrytning   -> användarens eget val; kasta vidare, ingen retry
//   redan strömmad text -> ALDRIG om, svaret skulle dubbleras i chatten
//
// Den sista är den som kostar mest om den går sönder, och den syns inte i ett
// icke-strömmande test.
// ─────────────────────────────────────────────────────────────────────────

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';

const Module = require('module');
const OUT = path.join(__dirname, '..');

/** Vad den fejkade instructServer bokför, så testet kan granska besluten. */
interface ServerStub {
	endpointCalls: number;
	invalidations: number;
	begun: number;
	ended: number;
}

/**
 * Laddar en FÄRSK kopia av den kompilerade instructModel.js med stubbade
 * beroenden. Färsk varje gång: modulen cachar inget själv, men stubbarna måste
 * kunna räknas per test.
 */
function loadInstructModel(fetchImpl: typeof fetch): {
	instructOneShot: any;
	stub: ServerStub;
} {
	const stub: ServerStub = {
		endpointCalls: 0,
		invalidations: 0,
		begun: 0,
		ended: 0,
	};

	const serverStub = {
		instructEndpoint: async () => {
			stub.endpointCalls++;
			return {
				baseUrl: 'http://127.0.0.1:11436',
				apiKey: 'k',
				modelName: 'granite.gguf',
			};
		},
		instructInstalled: () => true,
		beginInstructCall: () => {
			stub.begun++;
		},
		endInstructCall: () => {
			stub.ended++;
		},
		invalidateInstructEndpoint: () => {
			stub.invalidations++;
		},
	};

	const serverPath = path.join(OUT, 'instructServer.js');
	const modelPath = path.join(OUT, 'instructModel.js');

	const origLoad = Module._load;
	Module._load = function (request: string, parent: any, ...rest: any[]) {
		if (request === 'vscode') {
			return {};
		}
		if (parent?.filename === modelPath && request.endsWith('instructServer.js')) {
			return serverStub;
		}
		return origLoad.call(this, request, parent, ...rest);
	};

	// fetch sätts på globalThis och får INTE återställas här. Modulen slår upp
	// den vid ANROPET, inte vid laddningen, så en återställning i ett finally
	// hade gett tillbaka den riktiga fetch:en -- och testet hade tyst börjat
	// ringa 127.0.0.1:11436 på riktigt. Städningen sker i teardown() nedan.
	globalThis.fetch = fetchImpl;

	try {
		delete require.cache[modelPath];
		delete require.cache[serverPath];
		const mod = require(modelPath);
		return { instructOneShot: mod.instructOneShot, stub };
	} finally {
		Module._load = origLoad;
		delete require.cache[modelPath];
	}
}

const REAL_FETCH = globalThis.fetch;

/** Ett kontaktfel av samma sort som fetch kastar vid ECONNREFUSED. */
function connectionError(): Error {
	const err = new TypeError('fetch failed');
	(err as any).cause = { code: 'ECONNREFUSED' };
	return err;
}

function jsonResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * En SSE-ström i llama.cpp/OpenAI-form.
 *
 * PULL och inte start(): controller.error() TÖMMER kön. Enqueuear man allt i
 * start() och sedan felar, får konsumenten aldrig se de chunkar som låg där --
 * och ett test som vill bevisa "text hann matas ut FÖRE felet" hade då mätt
 * motsatsen utan att säga till. Med pull() levereras en chunk per läsning, och
 * felet inträffar först när konsumenten ber om just den.
 *
 * failAt = index som felar i stället för att leverera. -1 = strömmen går hel.
 */
function sseResponse(chunks: string[], failAt = -1): Response {
	const enc = new TextEncoder();
	let i = 0;
	const body = new ReadableStream({
		pull(controller) {
			if (i === failAt) {
				controller.error(connectionError());
				return;
			}
			if (i >= chunks.length) {
				controller.enqueue(enc.encode('data: [DONE]\n'));
				controller.close();
				return;
			}
			const c = chunks[i++];
			controller.enqueue(
				enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`)
			);
		},
	});
	return new Response(body, { status: 200 });
}

const OPTS = { system: 's', user: 'u' };

suite('Instruct: omforsok pa kontaktfel', () => {

	teardown(() => {
		globalThis.fetch = REAL_FETCH;
	});

	test('kontaktfel -> slapper cachen och lyckas pa andra forsoket', async () => {
		let calls = 0;
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			if (calls === 1) {
				throw connectionError();
			}
			return jsonResponse('andra forsoket');
		});

		const out = await instructOneShot(OPTS);

		assert.strictEqual(out, 'andra forsoket');
		assert.strictEqual(calls, 2, 'anropet gjordes inte om');
		assert.strictEqual(stub.invalidations, 1, 'den cachade endpointen slapptes inte');
		assert.strictEqual(stub.endpointCalls, 2, 'andra forsoket hamtade inte en ny endpoint');
	});

	test('KRITISKT: bara ETT omforsok -- andra kontaktfelet kastas vidare', async () => {
		let calls = 0;
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			throw connectionError();
		});

		await assert.rejects(() => instructOneShot(OPTS), /fetch failed/);
		assert.strictEqual(calls, 2, 'forvantade exakt tva forsok');
		assert.strictEqual(stub.invalidations, 1);
	});

	test('KRITISKT: ett HTTP-fel gors INTE om -- servern lever och sa nej', async () => {
		// Skillnaden ar hela poangen. En 500:a betyder att llama-server tog emot
		// anropet; att skicka det igen doljer felet och dubblar lasten.
		let calls = 0;
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			return new Response('context shift failed', { status: 500 });
		});

		await assert.rejects(() => instructOneShot(OPTS), /500/);
		assert.strictEqual(calls, 1, 'ett HTTP-fel utloste ett omforsok');
		assert.strictEqual(stub.invalidations, 0, 'endpointen slapptes trots att servern svarade');
	});

	test('KRITISKT: anvandarens avbrytning gors INTE om', async () => {
		let calls = 0;
		const ac = new AbortController();
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			ac.abort();
			const err = new Error('The operation was aborted.');
			err.name = 'AbortError';
			throw err;
		});

		await assert.rejects(() => instructOneShot({ ...OPTS, signal: ac.signal }));
		assert.strictEqual(calls, 1, 'en avbrytning utloste ett omforsok');
		assert.strictEqual(stub.invalidations, 0);
	});

	test('bokforingen gar ihop: varje beginCall har ett endCall', async () => {
		// Utan det kan idle-timern aldrig armas om, och modellen ligger kvar i
		// minnet for alltid efter ett misslyckat anrop.
		let calls = 0;
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			if (calls === 1) {
				throw connectionError();
			}
			return jsonResponse('ok');
		});

		await instructOneShot(OPTS);
		assert.strictEqual(stub.begun, 2);
		assert.strictEqual(stub.ended, 2, 'inFlight-bokforingen lacker vid omforsok');
	});
});

suite('Instruct: stromning far aldrig dubbleras', () => {

	teardown(() => {
		globalThis.fetch = REAL_FETCH;
	});

	test('kontaktfel INNAN forsta tecknet -> omforsok ar ofarligt', async () => {
		let calls = 0;
		const seen: string[] = [];
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			if (calls === 1) {
				return sseResponse(['aldrig'], 0); // dor pa forsta chunken
			}
			return sseResponse(['hela ', 'svaret']);
		});

		const out = await instructOneShot({
			...OPTS,
			onDelta: (c: string) => seen.push(c),
		});

		assert.strictEqual(out, 'hela svaret');
		assert.deepStrictEqual(seen, ['hela ', 'svaret'], 'text dubblerades');
		assert.strictEqual(calls, 2);
		assert.strictEqual(stub.invalidations, 1);
	});

	test('KRITISKT: kontaktfel EFTER utmatad text -> INGET omforsok', async () => {
		// Det har ar den dyra. Stromen har redan landat i chatten; ett andra
		// forsok hade skrivit hela svaret en gang till efter det halva.
		// Ett halvt svar ar battre an ett dubblerat.
		let calls = 0;
		const seen: string[] = [];
		const { instructOneShot, stub } = loadInstructModel(async () => {
			calls++;
			return sseResponse(['forsta ', 'andra ', 'ALDRIG'], 2);
		});

		await assert.rejects(() =>
			instructOneShot({ ...OPTS, onDelta: (c: string) => seen.push(c) })
		);

		assert.strictEqual(calls, 1, 'anropet gjordes om trots att text redan matats ut');
		assert.strictEqual(stub.invalidations, 0);
		assert.deepStrictEqual(seen, ['forsta ', 'andra '], 'ovantad utmatning');
	});
});
