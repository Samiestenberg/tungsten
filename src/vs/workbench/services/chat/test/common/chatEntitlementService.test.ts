/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatEntitlement, chatRequiresSetup, IChatSetupRequirement } from '../../common/chatEntitlementService.js';

// TUNGSTEN: den har sviten ar VAND mot upstream, med flit.
//
// Upstream testade att chatRequiresSetup() svarar JA i de lagen dar anvandaren
// maste logga in pa GitHub Copilot eller registrera sig. I Tungsten finns
// inget konto att logga in pa -- bada modellerna foljer med i installern och
// kor mot 127.0.0.1 -- sa funktionen svarar alltid nej.
//
// Varfor testerna star kvar i stallet for att raderas: den har funktionen ar
// ENDA kallan for beslutet, och tva ytor lyssnar pa den (setup-agenten och
// modellvaljarens "Sign in to use Copilot"-rubrik). Bada var NABARA i det
// packade bygget innan den har andringen. Faller nagon av raderna nedan har en
// upstream-merge eller en slarvig refaktor lagt tillbaka inloggningsflodet,
// och det ska synas i CI -- inte i en skarmdump manader senare.

suite('chatRequiresSetup (Tungsten: always false)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function context(overrides: Partial<IChatSetupRequirement> = {}): IChatSetupRequirement {
		return {
			completed: true,
			disabled: false,
			untrusted: false,
			entitlement: ChatEntitlement.Pro,
			anonymous: false,
			hasByokModels: false,
			...overrides,
		};
	}

	test('a completed, signed-up user does not require setup', () => {
		assert.strictEqual(chatRequiresSetup(context()), false);
	});

	test('not completed still does not require setup', () => {
		assert.strictEqual(chatRequiresSetup(context({ completed: false })), false);
	});

	test('disabled still does not require setup', () => {
		assert.strictEqual(chatRequiresSetup(context({ disabled: true })), false);
	});

	test('untrusted still does not require setup', () => {
		// Restricted Mode hanteras av modellvaljarens egna restricted-gren, som
		// kors fore den har -- den grenen ar ORORD och visar fortfarande
		// "Trust Workspace to enable models...".
		assert.strictEqual(chatRequiresSetup(context({ untrusted: true })), false);
	});

	test('entitlement Available does not trigger a sign-up prompt', () => {
		assert.strictEqual(chatRequiresSetup(context({ entitlement: ChatEntitlement.Available })), false);
	});

	test('KRITISKT: signed out never asks the user to sign in', () => {
		// Det har var raden som producerade "Sign in to use Copilot" i det
		// packade bygget: ingen ar inloggad, sa entitlement ar Unknown.
		assert.strictEqual(chatRequiresSetup(context({ completed: true, entitlement: ChatEntitlement.Unknown })), false);
		assert.strictEqual(chatRequiresSetup(context({ completed: false, entitlement: ChatEntitlement.Unknown })), false);
	});

	test('KRITISKT: no combination of inputs asks for setup', () => {
		// Uttommande over alla booleska falt och alla entitlement-varden. Om
		// nagon lagger tillbaka ett villkor fangas det har oavsett vilket.
		const entitlements = Object.values(ChatEntitlement).filter(v => typeof v === 'number') as ChatEntitlement[];
		for (const completed of [true, false]) {
			for (const disabled of [true, false]) {
				for (const untrusted of [true, false]) {
					for (const anonymous of [true, false]) {
						for (const hasByokModels of [true, false]) {
							for (const entitlement of entitlements) {
								const input = { completed, disabled, untrusted, anonymous, hasByokModels, entitlement };
								assert.strictEqual(
									chatRequiresSetup(input),
									false,
									`chatRequiresSetup returned true for ${JSON.stringify(input)}`
								);
							}
						}
					}
				}
			}
		}
	});
});
