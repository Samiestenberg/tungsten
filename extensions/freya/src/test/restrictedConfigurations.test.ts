/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Att en fientlig arbetsyta inte kan peka om Freya, bevisat i manifestet.
//
// BAKGRUNDEN: tillägget kör med untrustedWorkspaces.supported: "limited", så
// den lätta lanen är PÅ även i en mapp användaren inte litat på. Det är rätt
// avvägning -- den läser bara och pratar med en process vi själva startat på
// 127.0.0.1 -- men den vilar helt på att arbetsytan inte får ändra VART texten
// skickas eller VILKEN binär vi startar. Den spärren är
// capabilities.untrustedWorkspaces.restrictedConfigurations i package.json.
//
// Verifieringen i en riktig fientlig .vscode/settings.json är manuell och görs
// per release (fräsch profil, obetrodd mapp, plantera settings.json, se att
// omdirigeringen ignoreras). Det som INTE går att göra manuellt varje gång är
// att komma ihåg spärren när en NY inställning läggs till. Därför det här
// testet: det listar de farliga inställningarna och faller om någon av dem
// saknas i spärrlistan.
//
// Testet är avsiktligt skrivet mot manifestet och inte mot ett kört fönster.
// Ett fönstertest hade behövt en riktig obetrodd arbetsyta och en riktig
// omstart; det här faller på fel sekund, i CI, av rätt anledning.

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function manifest(): any {
	// out/test/ -> ../../package.json
	const file = path.join(__dirname, '..', '..', 'package.json');
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function restricted(): string[] {
	return manifest().capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
}

function configuredSettings(): string[] {
	return Object.keys(manifest().contributes?.configuration?.properties ?? {});
}

/**
 * Inställningar som styr VART trafik går eller VILKEN binär som startas.
 * Var och en är en väg för en fientlig arbetsyta att fånga upp koden i filerna
 * eller köra en egen .exe, så var och en MÅSTE vara spärrad.
 */
const MUST_BE_RESTRICTED = [
	// FIM-lanen (1.5B, port 11435)
	'freya.local.runtimePath',
	'freya.local.port',
	// Instruct-lanen (3B, port 11436). Samma två vägar, samma spärr.
	'freya.instruct.runtimePath',
	'freya.instruct.port',
	// Ollama-reserven: en URL som pekar var som helst.
	'freya.ollama.url',
	// Nedladdnings-URL:en. En fientlig arbetsyta som far peka om den kan
	// servera EN EGEN GGUF, som vi sedan spawnar som barnprocess. Storleks-
	// och sha256-kontrollen fangar det, men sparren ska sitta anda: den ar
	// forsta forsvarslinjen och kraver ingen kontroll for att halla.
	'freya.runtime.baseUrl',
];

suite('Restricted Mode: fientlig arbetsyta kan inte peka om Freya', () => {

	test('untrustedWorkspaces är "limited", inte false', () => {
		// false = tillägget aktiveras inte alls och användaren får en app som
		// ser trasig ut utan förklaring. Det var felet Fas 1 rättade.
		assert.strictEqual(manifest().capabilities?.untrustedWorkspaces?.supported, 'limited');
	});

	test('varje omdirigerande inställning är spärrad', () => {
		const locked = restricted();
		for (const key of MUST_BE_RESTRICTED) {
			assert.ok(
				locked.includes(key),
				`${key} saknas i restrictedConfigurations -- en fientlig .vscode/settings.json ` +
				`kan peka om den från workspace-scope`
			);
		}
	});

	test('spärrlistan innehåller bara inställningar som faktiskt finns', () => {
		// En felstavad nyckel i listan spärrar ingenting men ser ut att göra det.
		const declared = new Set(configuredSettings());
		for (const key of restricted()) {
			assert.ok(declared.has(key), `${key} är spärrad men finns inte som inställning`);
		}
	});

	test('INGEN ny port-, sökvägs- eller URL-inställning slinker förbi', () => {
		// Vakten mot framtiden: den som lägger till freya.<något>.port eller
		// .runtimePath eller något som slutar på url/uri måste också spärra den.
		//
		// Mönstret matchar SLUTET av sista segmentet och inte bara ".url",
		// eftersom freya.runtime.baseUrl annars hade sluppit förbi -- vilket den
		// gjorde tills det upptäcktes. Ett namn som "downloadUrl", "mirrorUri"
		// eller "apiPort" fångas nu av samma regel.
		const dangerous = configuredSettings().filter(key =>
			/\.[a-z0-9]*(port|runtimepath|url|uri|endpoint|host)$/i.test(key)
		);
		const locked = new Set(restricted());
		const leaked = dangerous.filter(key => !locked.has(key));
		assert.deepStrictEqual(
			leaked,
			[],
			`nya omdirigerande inställningar utan spärr: ${leaked.join(', ')}`
		);
	});

	test('instruct-lanen deklarerar samma sorts inställningar som FIM-lanen', () => {
		// Speglingen är poängen: 3B-lanen ska inte uppfinna egna konventioner.
		const settings = new Set(configuredSettings());
		for (const suffix of ['enabled', 'port', 'contextSize', 'runtimePath']) {
			assert.ok(settings.has(`freya.local.${suffix}`), `freya.local.${suffix} saknas`);
			assert.ok(settings.has(`freya.instruct.${suffix}`), `freya.instruct.${suffix} saknas`);
		}
	});

	test('portarna krockar inte med varandra eller med Ollama', () => {
		const props = manifest().contributes.configuration.properties;
		const fim = props['freya.local.port'].default;
		const instruct = props['freya.instruct.port'].default;
		assert.notStrictEqual(fim, 11434, 'FIM-porten är Ollamas');
		assert.notStrictEqual(instruct, 11434, 'instruct-porten är Ollamas');
		assert.notStrictEqual(fim, instruct, 'de två lanerna delar port');
	});
});
