/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { RawContextKey } from '../../contextkey/common/contextkey.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Registry } from '../../registry/common/platform.js';

/** @internal Only the enablement service may read this configuration value at runtime. */
const agentHostEnabledSettingId = 'chat.agentHost.enabled';

/** Context key set by {@link IAgentHostEnablementService}. Use in `when` clauses to gate UI on Agent Host enablement, including `chat.disableAIFeatures`. */
export const AGENT_HOST_ENABLED_CONTEXT_KEY = new RawContextKey<boolean>('agentHostEnabled', false, { type: 'boolean', description: nls.localize('agentHostEnabled', "Whether Agent Host features are enabled.") });

export const IAgentHostEnablementService = createDecorator<IAgentHostEnablementService>('agentHostEnablementService');

export interface IAgentHostEnablementService {
	readonly _serviceBrand: undefined;
	/**
	 * Whether Agent Host features are enabled in this runtime.
	 * Requires `chat.agentHost.enabled === true`, a non-web runtime, and `chat.disableAIFeatures !== true`. This value is fixed at startup.
	 */
	readonly enabled: boolean;
}

// Register `chat.agentHost.enabled` and related settings.
// Intentionally kept in this file so the setting ID stays internal.
// Loaded by:
//   - `electronAgentHostStarter.ts` (main process, for default value awareness)
//   - `platform/agentHost/browser/agentHostEnablementService.ts` (renderer, via import)
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'chatAgentHost',
	title: nls.localize('chatAgentHostConfigurationTitle', "Chat Agent Host"),
	type: 'object',
	properties: {
		[agentHostEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('chat.agentHost.enabled', "When enabled, some agents run in a separate agent host process."),
			// TUNGSTEN: false.
			//
			// Agent-hosten kor externa agenter (Copilot CLI, Claude, Codex) i en
			// egen process och registrerar en session-typ per agent, med
			// kommandon som "open new Copilot CLI session".
			//
			// Upstream-defaulten var `!isWeb && product.quality !== 'stable'`.
			// Tungstens product.json har INGEN quality-nyckel, sa uttrycket blev
			// `undefined !== 'stable'` = true: agent-hosten var PASLAGEN, och
			// agent-host-copilotcli-kommandona lag registrerade i det packade
			// bygget. Det syntes inte i koden -- det upptacktes genom att fraga
			// det korande fonstret vilka kommandon som faktiskt fanns.
			//
			// Tungsten har en chatt: den lokala 3B-guiden. En andra agent-yta
			// som startar en molnagent hor inte hemma i ett bygge som lovar att
			// allt kor lokalt.
			default: false,
			tags: ['experimental', 'advanced'],
			experiment: { mode: 'startup' },
		},
		'chat.agents.copilotCli.hideExtensionHost': {
			type: 'boolean',
			markdownDescription: nls.localize('chat.agents.copilotCli.hideExtensionHost', "When enabled, hides the Extension Host Copilot CLI entry from the Agents window picker. Requires `#chat.agentHost.enabled#`.", agentHostEnabledSettingId),
			default: false,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		'chat.editor.preferCopilotHarness': {
			type: 'boolean',
			description: nls.localize('chat.editor.preferCopilotHarness', "When enabled, prefers the Agent Host Copilot CLI for new editor chat sessions. If the local harness is selected, it is replaced with Copilot once."),
			default: false,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		'chat.defaultToCopilotHarness': {
			type: 'boolean',
			markdownDescription: nls.localize('chat.defaultToCopilotHarness', "When enabled, new editor and panel chat sessions default to the Agent Host Copilot CLI instead of the local harness. Requires `#{0}#`.", agentHostEnabledSettingId),
			default: false,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		'chat.editor.localAgent.enabled': {
			type: 'boolean',
			description: nls.localize('chat.editor.localAgent.enabled', "When enabled, shows the VS Code local chat harness in the chat picker. This setting is ignored in virtual workspaces, where the local chat harness is always available."),
			default: true,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		'chat.editor.copilotCli.hideExtensionHost': {
			type: 'boolean',
			description: nls.localize('chat.editor.copilotCli.hideExtensionHost', "When enabled, hides the Extension Host Copilot CLI entry from the editor window chat picker."),
			default: false,
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
	}
});
