/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// NEDLADDNINGENS FELVAGAR.
//
// En modell som hamtas over natet och sedan spawnas som en BARNPROCESS ar exakt
// den sortens fil man inte far lita pa. Testerna nedan kor den riktiga
// offerDownload() mot en lokal server som ljuger pa olika satt, och kraver
// samma sak varje gang: inget halvfardigt eller fel innehall far bli liggande
// som en fardig .gguf, och felet ska vara begripligt.
//
// offerDownload() tar modellen som argument, sa testerna skickar sma egna
// poster i stallet for den riktiga 2,1 GB-modellen. Koden som kors ar densamma.

import 'mocha';
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const Module = require('module');
const OUT = path.join(__dirname, '..');

let baseUrl = '';
const messages: string[] = [];

function load(): { dl: any; layout: any } {
	const layoutPath = path.join(OUT, 'runtimeLayout.js');
	const dlPath = path.join(OUT, 'modelDownload.js');

	const fakeVscode = {
		workspace: {
			getConfiguration: () => ({ get: (k: string) => (k === 'runtime.baseUrl' ? baseUrl : undefined) }),
		},
		window: {
			// Anvandaren svarar alltid ja; det ar felvagarna vi testar.
			showInformationMessage: (_m: string, _o: any, ...items: string[]) => Promise.resolve(items[0]),
			showErrorMessage: (m: string) => {
				messages.push(m);
				return Promise.resolve(undefined);
			},
			withProgress: (_o: any, task: any) =>
				task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
		},
		ProgressLocation: { Notification: 15 },
		commands: { registerCommand: () => ({ dispose() {} }) },
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
		delete require.cache[layoutPath];
		delete require.cache[dlPath];
		return { layout: require(layoutPath), dl: require(dlPath) };
	} finally {
		Module._load = origLoad;
	}
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

suite('Modellhamtning: inget trasigt far bli liggande', () => {

	const GOOD = Buffer.from('GGUF fake weights, but a real byte stream.\n'.repeat(500));
	let server: http.Server | undefined;
	let root = '';
	/** Vad servern ska svara med. Satts per test. */
	let payload: Buffer = GOOD;

	setup(async () => {
		messages.length = 0;
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'tungsten-dl-'));
		payload = GOOD;
		server = http.createServer((_req, res) => {
			res.writeHead(200, { 'content-length': String(payload.length) });
			res.end(payload);
		});
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
		baseUrl = `http://127.0.0.1:${(server!.address() as any).port}`;
	});

	teardown(async () => {
		if (server) {
			await new Promise<void>((r) => server!.close(() => r()));
			server = undefined;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	function modelEntry(overrides: Partial<any> = {}): any {
		return {
			subdir: 'model-instruct',
			file: 'probe.gguf',
			urlPath: 'probe/probe.gguf',
			bytes: GOOD.length,
			sha256: sha(GOOD),
			label: 'Probe model',
			...overrides,
		};
	}

	function paths(layout: any, model: any) {
		const dest = path.join(root, model.subdir, model.file);
		return { dest, part: `${dest}.part`, found: () => layout.findModel(model.subdir) };
	}

	test('normalfallet: filen hamtas, verifieras och byter namn', async () => {
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		const model = modelEntry();
		const { dest, part, found } = paths(layout, model);

		assert.strictEqual(await dl.offerDownload(model), true);
		assert.ok(fs.existsSync(dest), 'ingen fardig fil');
		assert.ok(!fs.existsSync(part), '.part lag kvar');
		assert.strictEqual(fs.readFileSync(dest).length, GOOD.length);
		assert.ok(found(), 'findModel hittar inte den hamtade modellen');
	});

	test('KRITISKT: ratt storlek men FEL innehall avvisas', async () => {
		// Den farligaste formen av lognande spegel: content-length stammer, sa
		// bara hashen kan fanga det. Filen spawnas som barnprocess efterat.
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		payload = Buffer.alloc(GOOD.length, 0x41); // samma langd, annat innehall
		const model = modelEntry();
		const { dest, part, found } = paths(layout, model);

		assert.strictEqual(await dl.offerDownload(model), false);
		assert.ok(!fs.existsSync(dest), 'en fil med fel innehall accepterades');
		assert.ok(!fs.existsSync(part), '.part lag kvar');
		assert.strictEqual(found(), undefined);
		assert.ok(
			messages.some((m) => /checksum mismatch/i.test(m)),
			`intet begripligt fel: ${JSON.stringify(messages)}`
		);
	});

	test('KRITISKT: fel storlek avvisas', async () => {
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		const model = modelEntry({ bytes: GOOD.length + 4242 });
		const { dest, part } = paths(layout, model);

		assert.strictEqual(await dl.offerDownload(model), false);
		assert.ok(!fs.existsSync(dest));
		assert.ok(!fs.existsSync(part));
		assert.ok(
			messages.some((m) => /wrong size/i.test(m)),
			`intet begripligt fel: ${JSON.stringify(messages)}`
		);
	});

	test('KRITISKT: en modell UTAN pinnad hash hamtas inte alls', async () => {
		// COMPLETION_DOWNLOAD har sha256: "". Den har inga anropsstallen idag,
		// men konstanten ar exporterad -- och en tyst hamtning utan hashkontroll
		// vore det varsta utfallet av alla.
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		const model = modelEntry({ sha256: '' });
		const { dest, part } = paths(layout, model);

		assert.strictEqual(await dl.offerDownload(model), false);
		assert.ok(!fs.existsSync(dest));
		assert.ok(!fs.existsSync(part));
		assert.ok(
			messages.some((m) => /no pinned SHA-256/i.test(m)),
			`intet begripligt fel: ${JSON.stringify(messages)}`
		);
	});

	test('KRITISKT: ett skrivfel failar RENT i stallet for att hanga', async () => {
		// Det realistiska felet ar att disken tar slut mitt i 2,1 GB.
		//
		// FORE FIXEN fanns ingen felhanterare pa WriteStream:en. Felet blev da ett
		// OHANTERAT strommfel utanfor vart try/catch -- uppmatt med en katalog i
		// vagen for .part-filen:
		//
		//   Error: EISDIR: illegal operation on a directory, open '...gguf.part'
		//   Emitted 'error' event on WriteStream instance at: ...
		//
		// och hade felet kommit medan vi vantade pa "drain" hade den vantan aldrig
		// lossts upp: en progressruta som aldrig blir klar. pipeline() propagerar
		// felet i stallet.
		//
		// Har blockeras MALKATALOGEN med en fil. (Katalogtricket ovan gar inte
		// langre att anvanda i ett test: temp-filens namn ar numera unikt per
		// hamtning, sa det gar inte att lagga nagot i vagen for det i forvag.)
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		const model = modelEntry();
		const { dest } = paths(layout, model);
		fs.writeFileSync(path.dirname(dest), 'inte en katalog');

		const result = await Promise.race([
			dl.offerDownload(model),
			new Promise((r) => setTimeout(() => r('HANG'), 8000)),
		]);

		assert.strictEqual(result, false, 'hamtningen hangde eller lyckades felaktigt');
		assert.ok(!fs.existsSync(dest), 'en fardig fil skapades trots skrivfel');
		assert.ok(
			messages.some((m) => /EISDIR|ENOSPC|EACCES|EPERM|ENOTDIR|EEXIST/i.test(m)),
			`orsaken syns inte i beskedet: ${JSON.stringify(messages)}`
		);
	});

	test('inga temp-filer lamnas kvar efter ett misslyckande', async () => {
		// Temp-filen heter numera <dest>.<pid>-<tid>.part, sa ett test som bara
		// tittar efter "<dest>.part" hade varit falskt tryggt.
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		payload = Buffer.alloc(GOOD.length, 0x41); // fel innehall
		const model = modelEntry();
		const { dest } = paths(layout, model);

		assert.strictEqual(await dl.offerDownload(model), false);
		const leftovers = fs
			.readdirSync(path.dirname(dest))
			.filter((n) => n.endsWith('.part'));
		assert.deepStrictEqual(leftovers, [], `temp-filer kvar: ${leftovers.join(', ')}`);
	});

	test('en redan hamtad fil hamtas inte igen', async () => {
		const { dl, layout } = load();
		layout.setDownloadRoot(root);
		const model = modelEntry();
		const { dest } = paths(layout, model);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, 'redan har');

		assert.strictEqual(await dl.offerDownload(model), true);
		assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'redan har', 'filen skrevs over');
	});
});
