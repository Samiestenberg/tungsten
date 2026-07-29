/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PRIVACY-VERIFIERINGEN. Produktlofte, bevisat i stallet for lovat.
//
// Tungsten sager att allt kor lokalt: tva modeller foljer med i installern, de
// kor som barnprocesser mot 127.0.0.1, och default-bygget gor ingen utgaende
// natverkstrafik for AI. Det ar latt att saga och latt att av misstag gora
// osant -- en ny import racker.
//
// Testerna nedan foljer den FAKTISKA importgrafen fran extension.ts och kraver:
//
//   1. att moln-tiern ar avstangd,
//   2. att ingen aktiv modul ens NAMNER CLOUDFLARE_-uppgifter,
//   3. att ingen aktiv modul kan na en annan vard an 127.0.0.1/localhost,
//   4. att den vilande koden ar just vilande -- inte importerad.
//
// Grafen lases ur den KOMPILERADE koden (out/), inte ur kallan. Det ar den som
// faktiskt kors, och en import som bara finns i typvarlden syns inte dar --
// vilket ar ratt: en typimport skickar ingenting nagonstans.

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// cloud.ts importeras MEDVETET INTE har. Den importerar vscode, som inte finns
// utanfor en extension host -- men viktigare: ett test som maste ladda den
// vilande modulen for att bevisa att den ar vilande vore sitt eget motsagelse.
// Vi laser den som text i stallet.

const OUT_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(__dirname, '..', '..', 'src');

/** Moduler som ar MEDVETET vilande och aldrig far dyka upp i den aktiva grafen. */
const DORMANT = ['cloud.js', 'participant.js', 'workersai.js', 'agent.js', 'tools.js'];

/**
 * Alla moduler som gar att na fran extension.js via require().
 *
 * Regexen letar require("./x.js") och require("../y/z.js") i den kompilerade
 * koden. TypeScripts commonjs-utdata skriver exakt sa.
 */
function activeModuleGraph(): Map<string, string> {
	const seen = new Map<string, string>();
	const queue = [path.join(OUT_DIR, 'extension.js')];

	while (queue.length > 0) {
		const file = queue.pop()!;
		const key = path.relative(OUT_DIR, file).replace(/\\/g, '/');
		if (seen.has(key) || !fs.existsSync(file)) {
			continue;
		}
		const source = fs.readFileSync(file, 'utf8');
		seen.set(key, source);

		for (const m of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
			queue.push(path.resolve(path.dirname(file), m[1]));
		}
	}
	return seen;
}

suite('Privacy: moln-tiern ar av', () => {

	test('avstangningen ar en KONSTANT false, inte en installning', () => {
		// En installning hade kunnat sattas fran en fientlig .vscode/settings.json
		// eller av misstag i en profil. En konstant kraver en kodandring och ett
		// nytt bygge. Typen `false` gor dessutom varje jamforelse mot true till
		// ett typfel i stallet for en tyst andring.
		const source = fs.readFileSync(path.join(SRC_DIR, 'cloud.ts'), 'utf8');
		assert.ok(
			/export const CLOUD_TIER_ENABLED: false = false;/.test(source),
			'CLOUD_TIER_ENABLED ar inte langre en hardkodad false'
		);
		assert.ok(
			!/getConfiguration\([^)]*\)[\s\S]{0,80}CLOUD_TIER/.test(source),
			'flaggan lases ur konfigurationen'
		);
	});

	test('KRITISKT: grinden ligger FORE varje lasning av nycklar', () => {
		// Skillnaden mellan "vi anvander inte nycklarna" och "vi ror dem inte".
		// Varje exporterad funktion i cloud.ts som kan lasa en nyckel maste
		// borja med CLOUD_TIER_ENABLED-kontrollen.
		const source = fs.readFileSync(path.join(SRC_DIR, 'cloud.ts'), 'utf8');
		const bodies = source.split(/export (?:async )?function /).slice(1);
		assert.ok(bodies.length >= 3, `hittade bara ${bodies.length} exporterade funktioner`);

		for (const body of bodies) {
			const name = /^\w+/.exec(body)?.[0] ?? '?';
			if (!/resolveSecret|ctx\.secrets/.test(body)) {
				continue; // ror inga nycklar
			}
			const gate = body.indexOf('CLOUD_TIER_ENABLED');
			const firstRead = Math.min(
				...['resolveSecret', 'ctx.secrets']
					.map((needle) => body.indexOf(needle))
					.filter((i) => i >= 0)
			);
			assert.ok(gate >= 0, `${name} laser nycklar utan att kolla CLOUD_TIER_ENABLED`);
			assert.ok(
				gate < firstRead,
				`${name} laser nycklar INNAN CLOUD_TIER_ENABLED-grinden`
			);
		}
	});
});

suite('Privacy: den aktiva grafen nar inte ut ur maskinen', () => {

	test('grafen gar att lasa och ar inte tom', () => {
		const graph = activeModuleGraph();
		assert.ok(graph.size > 10, `hittade bara ${graph.size} moduler -- lases out/ verkligen?`);
		assert.ok(graph.has('extension.js'));
	});

	test('KRITISKT: ingen aktiv modul namner CLOUDFLARE_-uppgifter', () => {
		for (const [name, source] of activeModuleGraph()) {
			assert.ok(
				!source.includes('CLOUDFLARE_'),
				`${name} namner CLOUDFLARE_ -- default-bygget far inte lasa molnnycklar`
			);
			assert.ok(
				!source.includes('cloudflareApiToken') && !source.includes('cloudflareAccountId'),
				`${name} ror de lagrade molnnycklarna`
			);
		}
	});

	// modelDownload.js ar den ENDA modulen som far gora ett utgaende anrop, och
	// den har egna tester langre ner. Alla andra moduler far bara na 127.0.0.1.
	const DOWNLOADER = 'modelDownload.js';

	test('KRITISKT: ingen aktiv modul har en URL till en annan vard', () => {
		// Tillatna: 127.0.0.1 (vara egna modellservrar) och localhost
		// (Ollama-reserven, som anvandaren sjalv maste sla pa).
		const allowed = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/;
		for (const [name, source] of activeModuleGraph()) {
			if (name.endsWith(DOWNLOADER)) {
				continue; // undantaget, med egna tester nedan
			}
			for (const m of source.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
				const url = m[0];
				// Lankar i anvandartext (ollama.com/download, github-repot) ar
				// text, inte trafik -- de blir bara klickbara om nagon klickar.
				if (/ollama\.com|github\.com|developer\.mozilla/.test(url)) {
					continue;
				}
				assert.ok(
					allowed.test(url),
					`${name} innehaller ${url}, som inte ar 127.0.0.1 eller localhost`
				);
			}
		}
	});

	test('KRITISKT: bara EN modul far na natet', () => {
		// Undantaget ovan far inte vaxa tyst. Om en andra modul borjar prata ut
		// ska det vara ett medvetet beslut, inte nagot som glider in.
		const withRemoteUrls = [...activeModuleGraph()]
			.filter(([, source]) =>
				[...source.matchAll(/https?:\/\/[^\s"'`)]+/g)]
					.some(m => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(m[0])
						&& !/ollama\.com|github\.com|developer\.mozilla/.test(m[0])))
			.map(([name]) => name);

		assert.deepStrictEqual(
			withRemoteUrls,
			[DOWNLOADER],
			`forvantade att bara ${DOWNLOADER} har en fjarr-URL`
		);
	});
});

suite('Privacy: modellhamtningen ar konfigurerbar och verifierad', () => {

	function downloaderSource(): string {
		const file = path.join(SRC_DIR, 'modelDownload.ts');
		return fs.readFileSync(file, 'utf8');
	}

	test('bas-URL:en kommer ur KONFIGURATIONEN, inte ur koden', () => {
		// Kravet: den som vill lagga vikterna pa sin egen host (R2, en intern
		// spegel) ska kunna gora det utan att bygga om. Da far adressen inte
		// vara last i koden.
		const src = downloaderSource();
		assert.ok(
			/get<string>\("runtime\.baseUrl"\)/.test(src),
			'baseUrl lases inte ur konfigurationen'
		);
		assert.ok(
			/`\$\{downloadBaseUrl\(\)\}\//.test(src),
			'URL:en byggs inte fran den konfigurerade basen'
		);
	});

	// Tungstens EGEN release-bucket. Publik, anonymt lasbar, och innehallet ar
	// pinnat av sha256:n nedan -- verifierat genom att hasha objektet pa
	// serversidan efter uppladdningen, inte genom att lita pa att det lag ratt.
	const RELEASE_HOST = 'https://pub-7ae5d28171f348d19d1b8f1db9ab7253.r2.dev';

	test('KRITISKT: ingen intern eller privat adress ar hardkodad', () => {
		// VAD DET HAR TESTET SKYDDAR MOT, och vad som andrades.
		//
		// Tidigare kravdes att VARJE hardkodad URL var huggingface.co, och
		// strangen 'r2.dev' var svartlistad rakt av. Det var ratt sa lange
		// defaulten var HuggingFace: da kunde en r2.dev-adress i filen bara
		// betyda att nagons privata spegel smugit in.
		//
		// Nu ar defaulten Tungstens EGEN publika bucket, av skalet som star i
		// modelDownload.ts: den lilla installern maste kunna hamta 3B:n pa en
		// ren maskin, och vikterna dar ar samma fil som buntas i D1.
		//
		// Skyddet ar darfor inte borttaget utan SKARPT: r2.dev ar fortfarande
		// forbjudet, med undantag for exakt den har bucketen. En annan
		// pub-*.r2.dev-adress faller precis som forr.
		const src = downloaderSource();
		for (const m of src.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
			const url = m[0];
			assert.ok(
				/^https:\/\/huggingface\.co/.test(url) || url.startsWith(RELEASE_HOST),
				`hardkodad adress som varken ar den publika modellvarden eller ` +
				`Tungstens release-bucket: ${url}`
			);
		}
		// Vanliga former for interna varden. amazonaws och de privata natverken
		// har ingen legitim plats i filen alls.
		for (const bad of ['.internal', '.corp', '.local', '10.', '192.168.', 'amazonaws']) {
			assert.ok(!src.includes(bad), `hardkodad intern adress: ${bad}`);
		}
		// r2.dev far forekomma, men BARA som var egen bucket.
		for (const m of src.matchAll(/https?:\/\/[^\s"'`)]*r2\.dev[^\s"'`)]*/g)) {
			assert.ok(
				m[0].startsWith(RELEASE_HOST),
				`en annan r2.dev-adress an release-bucketen: ${m[0]}`
			);
		}
	});

	test('default-basen ar den bucket som faktiskt ar verifierad', () => {
		// Halla ihop tva sanningar som annars glider isar: konstanten i koden och
		// defaulten i manifestet. Ett bygge dar de skiljer sig hamtar fran en
		// annan host an den som testades.
		const src = downloaderSource();
		const inCode = /const DEFAULT_BASE_URL = "([^"]+)"/.exec(src)?.[1];
		const manifestDefault = JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
		).contributes.configuration.properties['freya.runtime.baseUrl'].default;

		assert.strictEqual(inCode, RELEASE_HOST, 'DEFAULT_BASE_URL ar inte release-bucketen');
		assert.strictEqual(
			manifestDefault,
			RELEASE_HOST,
			'manifestets default och DEFAULT_BASE_URL pekar pa olika hostar'
		);
	});

	test('KRITISKT: storlek OCH sha256 kontrolleras innan filen tas i bruk', () => {
		// En modell som hamtas over natet och sedan spawnas som barnprocess far
		// inte lita pa att den rakade ha ratt filnamn.
		const src = downloaderSource();
		assert.ok(/written !== model\.bytes/.test(src), 'storleken kontrolleras inte');
		assert.ok(/actual !== model\.sha256/.test(src), 'sha256 kontrolleras inte');
		// .part -> rename sker FORST efter kontrollerna.
		const rename = src.indexOf('renameSync');
		assert.ok(rename > src.indexOf('model.sha256'), 'filen byter namn innan den verifierats');
	});

	test('hamtningen sker aldrig utan att anvandaren sagt ja', () => {
		const src = downloaderSource();
		const ask = src.indexOf('showInformationMessage');
		const run = src.indexOf('downloadModel(model, dest');
		assert.ok(ask >= 0 && run >= 0 && ask < run, 'nedladdningen startar utan fraga');
		assert.ok(/modal: true/.test(src), 'fragan ar inte modal');
	});

	test('instruct-modellens hash matchar byggskriptets', () => {
		// Samma vikter maste ge samma kontroll, oavsett om de kom via installern
		// eller over natet. Tva sanningar hade glidit isar.
		const fetchScript = fs.readFileSync(
			path.join(SRC_DIR, '..', '..', '..', 'build', 'freya', 'fetchLocalRuntime.ts'),
			'utf8'
		);
		const inBuild = /sha256:\s*'([0-9a-f]{64})'/.exec(fetchScript)?.[1];
		const inExt = /sha256:\s*"([0-9a-f]{64})"/.exec(downloaderSource())?.[1];
		assert.ok(inBuild, 'hittade ingen sha256 i byggskriptet');
		assert.strictEqual(inExt, inBuild, 'byggskriptet och nedladdaren har olika hash');
	});

	test('KRITISKT: den vilande koden ar inte importerad', () => {
		const graph = activeModuleGraph();
		for (const dormant of DORMANT) {
			const found = [...graph.keys()].find((k) => k.endsWith(dormant));
			assert.strictEqual(
				found,
				undefined,
				`${dormant} nas fran extension.js -- den ska vara vilande`
			);
		}
	});

	test('ingen aktiv modul anropar Workers AI:s API', () => {
		for (const [name, source] of activeModuleGraph()) {
			assert.ok(
				!source.includes('api.cloudflare.com'),
				`${name} anropar Cloudflares API`
			);
			assert.ok(
				!/WorkersAIProvider/.test(source),
				`${name} anvander WorkersAIProvider`
			);
		}
	});
});

suite('Privacy: de retirerade defaultarna ar borta ur manifestet', () => {

	function manifest(): any {
		return JSON.parse(
			fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
		);
	}

	test('inga installningar for moln eller tung Ollama-modell', () => {
		const settings = Object.keys(
			manifest().contributes?.configuration?.properties ?? {}
		);
		for (const retired of [
			'freya.chat.backend',
			'freya.chat.workersAiModel',
			'freya.chat.ollamaModel',
			'freya.chat.maxSteps',
			'freya.commit.model',
		]) {
			assert.ok(
				!settings.includes(retired),
				`${retired} finns kvar men styr ingenting langre`
			);
		}
	});

	test('inga kommandon som ber om molnnycklar', () => {
		const commands: string[] = (manifest().contributes?.commands ?? []).map(
			(c: any) => c.command
		);
		assert.ok(!commands.includes('freya.setKeys'), 'freya.setKeys finns kvar i paletten');
		assert.ok(!commands.includes('freya.clearKeys'), 'freya.clearKeys finns kvar i paletten');
	});

	test('ingen installning namner 14B eller Workers AI', () => {
		const json = JSON.stringify(manifest().contributes?.configuration ?? {});
		assert.ok(!/coder:14b/i.test(json), 'qwen2.5-coder:14b namns fortfarande');
		assert.ok(!/workersai|workers ai/i.test(json), 'Workers AI namns fortfarande');
	});

	test('chat-participanten erbjuder inte agent-lage', () => {
		const modes: string[] = manifest().contributes?.chatParticipants?.[0]?.modes ?? [];
		assert.ok(!modes.includes('agent'), 'agent-laget star kvar i manifestet');
	});
});
