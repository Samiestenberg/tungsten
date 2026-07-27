/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Chattpanelens rad för obetrodda mappar.
//
// VARFÖR DEN LIGGER HÄR OCH INTE I extensions/freya: Freya deklarerar
// `untrustedWorkspaces.supported: false`, vilket betyder att VS Code inte
// aktiverar extensionen alls i restricted mode -- den får aldrig en chans att
// rendera något. Verifierat: i en obetrodd mapp finns ingen
// `_doActivateExtension tungsten.freya` i exthost-loggen. Raden måste därför
// komma från workbenchen.
//
// Utan den här filen visade panelen sin generiska "Build with Agent"-yta med
// ett fungerande inmatningsfält men ingen participant bakom -- alltså exakt
// det tysta försvinnandet vi ville bort från. Skriver man i fältet händer
// ingenting alls.
//
// chatViewsWelcome-registret är rätt mekanism: ChatViewPane#shouldShowWelcome()
// är redan true när det inte finns någon default-agent, och en obetrodd mapp är
// precis det fallet. Registret var bara tomt sedan Copilot togs bort.

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../../nls.js';
import { MANAGE_TRUST_COMMAND_ID, WorkspaceTrustContext } from '../../../workspace/common/workspace.js';
import { chatViewsWelcomeRegistry } from './chatViewsWelcome.js';

export function registerTungstenRestrictedModeWelcome(): void {
	// `firstLinkToButton` i ChatViewWelcomePart gör första länken till en knapp,
	// så command-länken nedan blir "Lita på mappen"-knappen.
	const content = new MarkdownString(
		localize(
			'tungsten.chat.restrictedMode.content',
			"Freya läser och skriver filer och kan köra kommandon, så agenten är avstängd i mappar du inte har litat på.\n\n[Lita på mappen]({0})",
			`command:${MANAGE_TRUST_COMMAND_ID}`
		),
		{ isTrusted: { enabledCommands: [MANAGE_TRUST_COMMAND_ID] } }
	);

	chatViewsWelcomeRegistry.register({
		title: localize('tungsten.chat.restrictedMode.title', "Freya är pausad i en obetrodd mapp"),
		icon: Codicon.shield,
		content,
		when: ContextKeyExpr.and(
			WorkspaceTrustContext.IsEnabled,
			WorkspaceTrustContext.IsTrusted.negate()
		)!
	});
}
