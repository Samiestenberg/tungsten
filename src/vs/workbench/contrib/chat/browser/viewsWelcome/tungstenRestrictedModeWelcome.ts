/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The chat panel's row for untrusted folders.
//
// WHY THIS LIVES HERE AND NOT IN extensions/freya: the chat panel's own model
// picker is disabled by the workbench in restricted mode (see
// modelPickerItemSections.ts), so a row that depends on a language model being
// available cannot come from the extension. This one is workbench-side and
// therefore always renders.
//
// It used to be the ONLY thing standing between a first-time user and silence:
// Freya declared `untrustedWorkspaces.supported: false` and was not activated at
// all in an untrusted folder. That is no longer the case -- the manifest now says
// `"limited"`, so the extension activates, the embedded 1.5B starts, and the
// light lane (autocomplete, commit messages, explanations) works while the agent
// stays off. This row remains as the chat panel's half of that message.
//
// Without this file the panel showed its generic "Build with Agent" surface with
// a working input box but no participant behind it -- exactly the silent
// disappearance we wanted rid of. Typing in that box did nothing at all.
//
// The chatViewsWelcome registry is the right mechanism: ChatViewPane#shouldShowWelcome()
// is already true when there is no default agent, and an untrusted folder is
// precisely that case. The registry was simply empty after Copilot was removed.

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../../nls.js';
import { MANAGE_TRUST_COMMAND_ID, WorkspaceTrustContext } from '../../../workspace/common/workspace.js';
import { chatViewsWelcomeRegistry } from './chatViewsWelcome.js';

export function registerTungstenRestrictedModeWelcome(): void {
	// `firstLinkToButton` in ChatViewWelcomePart turns the first link into a
	// button, so the command link below becomes the "Trust the folder" button.
	const content = new MarkdownString(
		localize(
			'tungsten.chat.restrictedMode.content',
			"Freya reads and writes files and can run commands, so the agent is disabled in folders you have not trusted.\n\n[Trust the folder]({0})",
			`command:${MANAGE_TRUST_COMMAND_ID}`
		),
		{ isTrusted: { enabledCommands: [MANAGE_TRUST_COMMAND_ID] } }
	);

	chatViewsWelcomeRegistry.register({
		title: localize('tungsten.chat.restrictedMode.title', "Freya is paused in an untrusted folder"),
		icon: Codicon.shield,
		content,
		when: ContextKeyExpr.and(
			WorkspaceTrustContext.IsEnabled,
			WorkspaceTrustContext.IsTrusted.negate()
		)!
	});
}
