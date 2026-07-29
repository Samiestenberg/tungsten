/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PORTINSTALLNINGEN, hela fallback-kedjan.
//
// `cfg().get<number>("instruct.port") ?? 11436` fangar bara att installningen
// SAKNAS. Ett handredigerat settings.json kan innehalla 0, -1, 70000 eller en
// strang, och da byggde vi en URL som http://127.0.0.1:0 och vantade ut hela
// halsokontrollen pa nagot som aldrig kan svara.
//
// Port 0 ar den lomskaste: llama-server tar da en SLUMPMASSIG ledig port och
// startar helt normalt -- loggen sager "listening on http://127.0.0.1:54321" --
// medan vi ringer :0. Inget ser trasigt ut, och inget fungerar.

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';

const Module = require('module');
const OUT = path.join(__dirname, '..');

/** Laddar en lane-modul med ETT konfigurationsvarde satt. */
function portFor(file: string, key: string, value: unknown): number {
	const target = path.join(OUT, file);
	const fakeVscode = {
		workspace: {
			getConfiguration: () => ({ get: (k: string) => (k === key ? value : undefined) }),
		},
		window: {
			createOutputChannel: () => ({
				info() {}, warn() {}, error() {}, trace() {}, dispose() {},
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
		const mod = require(target);
		return file.startsWith('instruct') ? mod.instructPort() : mod.localPort();
	} finally {
		Module._load = origLoad;
		delete require.cache[target];
	}
}

const LANES = [
	{ file: 'instructServer.js', key: 'instruct.port', fallback: 11436 },
	{ file: 'localServer.js', key: 'local.port', fallback: 11435 },
];

for (const lane of LANES) {
	suite(`Portinstallning: ${lane.key}`, () => {

		test('saknad installning ger standardporten', () => {
			assert.strictEqual(portFor(lane.file, lane.key, undefined), lane.fallback);
		});

		test('ett giltigt varde respekteras', () => {
			assert.strictEqual(portFor(lane.file, lane.key, 12345), 12345);
		});

		test('KRITISKT: port 0 avvisas', () => {
			// llama-server hade tagit en slumpmassig port och sett frisk ut medan
			// vi ringde :0.
			assert.strictEqual(portFor(lane.file, lane.key, 0), lane.fallback);
		});

		test('orimliga varden avvisas', () => {
			for (const bad of [-1, 70000, 1.5, NaN, 80, 'abc', null]) {
				assert.strictEqual(
					portFor(lane.file, lane.key, bad),
					lane.fallback,
					`${JSON.stringify(bad)} slank igenom`
				);
			}
		});

		test('Ollamas port tas aldrig', () => {
			// 11434 ar Ollamas. Bada lanerna backar darifran.
			assert.notStrictEqual(portFor(lane.file, lane.key, 11434), 11434);
		});
	});
}

suite('Portinstallning: lanerna krockar inte', () => {

	test('instruct-lanen tar inte FIM-lanens port', () => {
		// 11435 ar FIM-serverns. Skulle instruct-lanen hamna dar hade en /infill
		// och en /v1/chat/completions delat process.
		assert.notStrictEqual(portFor('instructServer.js', 'instruct.port', 11435), 11435);
	});
});
