/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PORTKOLLISION: att den upptackt, och att den sager RATT sak.
//
// ─────────────────────────────────────────────────────────────────────────
// VAD SOM FAKTISKT HANDE FORE FIXEN -- uppmatt mot den kompilerade koden med
// en frammande llama-server pa porten:
//
//   tid till besked            90,3 s
//   llama-server-processer     1 -> 2   (vi laste in 2 GB i onodan)
//   meddelandet                "the 3B instruct model is not installed in this
//                               build ... run fetchLocalRuntime.ts"
//
// Alla tre var fel. Modellen VAR installerad; problemet var porten. Och den
// andra processen fick aldrig en enda anslutning: pa Windows binder
// llama-server utan att klaga, men den FORSTA socketen behaller porten.
//
// EFTER:
//   tid till besked            5,2 s
//   llama-server-processer     1 -> 1   (ingen onodig spawn)
//   meddelandet                "Port N is already in use by another program ...
//                               set freya.instruct.port to a free port."
//
// Testerna nedan tacker de bitar som gar att kora utan en 2 GB-modell:
// portListening() sjalv, och att felmeddelandet skiljer pa de tva orsakerna.
// Sjalva 90 s -> 5 s-matningen ar en manuell probe och star dokumenterad har.
// ─────────────────────────────────────────────────────────────────────────

import 'mocha';
import * as assert from 'assert';
import * as net from 'net';
import * as path from 'path';

const Module = require('module');
const OUT = path.join(__dirname, '..');

/** Laddar en modul ur out/ med vscode stubbat. */
function loadWithFakeVscode<T>(file: string, fakeVscode: any): T {
	const target = path.join(OUT, file);
	const origLoad = Module._load;
	Module._load = function (request: string, ...rest: any[]) {
		if (request === 'vscode') {
			return fakeVscode;
		}
		return origLoad.call(this, request, ...rest);
	};
	try {
		delete require.cache[target];
		return require(target) as T;
	} finally {
		Module._load = origLoad;
		delete require.cache[target];
	}
}

suite('Portkollision: portListening upptacker en upptagen port', () => {

	let server: net.Server | undefined;
	let port = 0;

	setup(async () => {
		server = net.createServer();
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
		port = (server!.address() as net.AddressInfo).port;
	});

	teardown(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = undefined;
		}
	});

	function layout(): any {
		return loadWithFakeVscode('runtimeLayout.js', {
			env: { appRoot: 'C:/nowhere', machineId: 'test' },
		});
	}

	test('en port nagon lyssnar pa rapporteras som upptagen', async () => {
		assert.strictEqual(await layout().portListening(port), true);
	});

	test('en LEDIG port rapporteras som ledig', async () => {
		// Stang lyssnaren forst; samma portnummer ar da ledigt.
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		const closed = port;
		server = undefined;
		assert.strictEqual(await layout().portListening(closed), false);
	});

	test('svarar inom rimlig tid pa en ledig port', async () => {
		// Ett ECONNREFUSED ska komma direkt. Skulle det bli en timeout i stallet
		// har varje uppstart en dold fordrojning.
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		const closed = port;
		server = undefined;

		const t0 = Date.now();
		await layout().portListening(closed);
		assert.ok(Date.now() - t0 < 1500, 'portListening tog for lang tid pa en ledig port');
	});
});

suite('Portkollision: anvandaren far ratt orsak', () => {

	/**
	 * instructModel.js med instructServer stubbad, sa vi kan styra vad
	 * instructConflictingPort() svarar.
	 */
	function messageWhenConflict(
		conflictPort: number | undefined,
		opts: { turnedOff?: boolean; bundled?: boolean } = {}
	): string {
		const modelPath = path.join(OUT, 'instructModel.js');
		const serverStub = {
			instructEndpoint: async () => undefined,
			instructInstalled: () => true,
			beginInstructCall: () => {},
			endInstructCall: () => {},
			invalidateInstructEndpoint: () => {},
			instructConflictingPort: () => conflictPort,
			// Default: lanen ar pa, och bygget hade modellen med sig. Det ar
			// dev-tradets/D1:s lage, dar det gamla beskedet ar det ratta.
			instructTurnedOff: () => opts.turnedOff ?? false,
			instructBundledInBuild: () => opts.bundled ?? true,
		};

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
		try {
			delete require.cache[modelPath];
			return require(modelPath).instructUnavailableMessage();
		} finally {
			Module._load = origLoad;
			delete require.cache[modelPath];
		}
	}

	test('KRITISKT: en upptagen port skyller INTE pa en saknad modell', () => {
		// Den gamla texten sa "not installed in this build ... run
		// fetchLocalRuntime.ts". Modellen fanns; det var porten. Anvandaren blev
		// tillsagd att hamta nagot som redan lag pa disk -- och instruktionen var
		// dessutom riktad till ett dev-trad.
		const msg = messageWhenConflict(11436);
		assert.ok(/11436/.test(msg), 'porten namns inte');
		assert.ok(/in use/i.test(msg), 'sager inte att porten ar upptagen');
		assert.ok(/freya\.instruct\.port/.test(msg), 'sager inte hur man byter port');
		assert.ok(
			!/not installed/i.test(msg) && !/fetchLocalRuntime/.test(msg),
			'skyller fortfarande pa en saknad modell'
		);
	});

	test('utan portkonflikt star det gamla beskedet kvar', () => {
		const msg = messageWhenConflict(undefined);
		assert.ok(/not installed/i.test(msg), 'det vanliga beskedet forsvann');
	});

	// ─────────────────────────────────────────────────────────────────────
	// SAMMA FELKLASS, TVA YTOR TILL. Uppmatt 2026-07-30 mot en riktig
	// D2-installation: nar sha256-grinden stoppat en trasig nedladdning
	// svarade chatten
	//
	//   "not installed in this build. It ships with the packaged app; in a
	//    dev tree, run ... fetchLocalRuntime.ts"
	//
	// I D2-bygget ar bada leden fel. Modellen SKA inte ligga i bygget -- den
	// hamtas -- och fetchLocalRuntime.ts ar ett byggskript som inte finns i
	// en installation. Anvandaren skickas att leta efter fel sak, precis som
	// vid portkollisionen ovan.
	// ─────────────────────────────────────────────────────────────────────
	test('KRITISKT: D2-bygget sager HAMTA, inte "saknas i bygget"', () => {
		const msg = messageWhenConflict(undefined, { bundled: false });
		assert.ok(
			/download/i.test(msg),
			'sager inte att modellen ska hamtas'
		);
		assert.ok(
			!/fetchLocalRuntime/.test(msg),
			'hanvisar till ett byggskript som inte finns i en installation'
		);
		assert.ok(
			!/not installed in this build/i.test(msg),
			'pastar fortfarande att bygget ar ofullstandigt'
		);
		assert.ok(
			/Download the instruct model/.test(msg),
			'namner inte kommandot man faktiskt kor'
		);
	});

	test('avstangd lane skyller inte pa ett ofullstandigt bygge', () => {
		const msg = messageWhenConflict(undefined, { turnedOff: true });
		assert.ok(
			/freya\.instruct\.enabled/.test(msg),
			'sager inte vilken installning som star i vagen'
		);
		assert.ok(
			!/not installed/i.test(msg) && !/download/i.test(msg),
			'ber anvandaren fixa nagot som inte ar problemet'
		);
	});
});
