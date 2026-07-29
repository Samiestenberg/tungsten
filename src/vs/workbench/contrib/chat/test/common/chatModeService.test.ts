/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatMode, ChatModeService } from '../../common/chatModes.js';
import { ChatModeKind } from '../../common/constants.js';
import { IAgentSource, ICustomAgent, IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { createVSCodeHarnessDescriptor, CustomizationHarnessServiceBase, ICustomizationHarnessService } from '../../common/customizationHarnessService.js';
import { MockPromptsService } from './promptSyntax/service/mockPromptsService.js';
import { Target } from '../../common/promptSyntax/promptTypes.js';
import { SessionType } from '../../common/chatSessionsService.js';

class TestChatAgentService implements Partial<IChatAgentService> {
	_serviceBrand: undefined;

	private _hasToolsAgent = true;
	private readonly _onDidChangeAgents = new Emitter<any>();

	get hasToolsAgent(): boolean {
		return this._hasToolsAgent;
	}

	setHasToolsAgent(value: boolean): void {
		this._hasToolsAgent = value;
		this._onDidChangeAgents.fire(undefined);
	}

	readonly onDidChangeAgents = this._onDidChangeAgents.event;
}

suite('ChatModeService', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	const workspaceSource: IAgentSource = { storage: PromptsStorage.local };

	let instantiationService: TestInstantiationService;
	let promptsService: MockPromptsService;
	let chatAgentService: TestChatAgentService;
	let storageService: TestStorageService;
	let configurationService: TestConfigurationService;
	let chatModeService: ChatModeService;
	let customizationHarnessService: CustomizationHarnessServiceBase;

	setup(async () => {
		instantiationService = testDisposables.add(new TestInstantiationService());
		promptsService = new MockPromptsService();
		chatAgentService = new TestChatAgentService();
		storageService = testDisposables.add(new TestStorageService());
		configurationService = new TestConfigurationService();
		customizationHarnessService = testDisposables.add(new CustomizationHarnessServiceBase([createVSCodeHarnessDescriptor()], SessionType.Local, promptsService));
		instantiationService.stub(IPromptsService, promptsService);
		instantiationService.stub(IChatAgentService, chatAgentService);
		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(ICustomizationHarnessService, customizationHarnessService);

		chatModeService = testDisposables.add(instantiationService.createInstance(ChatModeService));
		// Eagerly create the ChatModes for the local session type and await
		// its initial async refresh so tests can rely on a settled state.
		await chatModeService.getLocalModes();
	});

	const waitForRefresh = async (): Promise<void> => {
		await (await chatModeService.getLocalModes()).waitForPendingUpdates();
	};

	test('should return builtin modes', async () => {
		const modes = await chatModeService.getLocalModes();

		// TUNGSTEN: 1, inte 3. Ask ar det enda inbyggda laget -- se
		// getBuiltinModes() i chatModes.ts.
		assert.strictEqual(modes.builtin.length, 1);
		assert.strictEqual(modes.custom.length, 0);

		// Check that Ask mode is always present
		const askMode = modes.builtin.find(mode => mode.id === ChatModeKind.Ask);
		assert.ok(askMode);
		assert.strictEqual(askMode.label.get(), 'Ask');
		assert.strictEqual(askMode.name.get(), 'ask');
		assert.strictEqual(askMode.kind, ChatModeKind.Ask);
	});

	// TUNGSTEN: de tva testerna nedan var upstream-tester for att Agent- och
	// Edit-lagena FANNS. I Tungsten ar Ask det enda inbyggda laget -- chatten ar
	// en guide till editorn pa en lokal 3B, inte en kodagent. Se
	// getBuiltinModes() i chatModes.ts for hela resonemanget.
	//
	// Testerna ar VANDA i stallet for borttagna: att Agent-laget inte kommer
	// tillbaka ar en egenskap som ska bevakas, precis som att det fanns var det
	// upstream.

	test('TUNGSTEN: agent mode is never offered, whatever the tools agent says', async () => {
		chatAgentService.setHasToolsAgent(true);
		let agents = await chatModeService.getLocalModes();
		assert.strictEqual(agents.builtin.find(agent => agent.id === ChatModeKind.Agent), undefined);

		chatAgentService.setHasToolsAgent(false);
		agents = await chatModeService.getLocalModes();
		assert.strictEqual(agents.builtin.find(agent => agent.id === ChatModeKind.Agent), undefined);
	});

	test('TUNGSTEN: Ask is the only builtin mode -- no Agent, no Edit', async () => {
		const agents = await chatModeService.getLocalModes();
		assert.deepStrictEqual(
			agents.builtin.map(mode => mode.id),
			[ChatModeKind.Ask],
			'the mode picker must offer Ask and nothing else'
		);
	});

	test('TUNGSTEN: agent mode cannot be reached by id either', async () => {
		// Lagesvaljaren ar en yta; findModeById ar en annan. Bada maste saga nej,
		// annars gar laget att na via en aterstalld session eller ett kommando.
		const agentMode = (await chatModeService.getLocalModes()).findModeById(ChatModeKind.Agent);
		assert.strictEqual(agentMode, undefined);
	});

	test('should find builtin modes by id', async () => {
		const askMode = (await chatModeService.getLocalModes()).findModeById(ChatModeKind.Ask);
		assert.ok(askMode);
		assert.strictEqual(askMode.id, ChatMode.Ask.id);
		assert.strictEqual(askMode.kind, ChatModeKind.Ask);
	});

	test('should return undefined for non-existent mode', async () => {
		const mode = (await chatModeService.getLocalModes()).findModeById('non-existent-mode');
		assert.strictEqual(mode, undefined);
	});

	test('should handle custom modes from prompts service', async () => {
		const customMode: ICustomAgent = {
			id: 'custom-mode',
			uri: URI.parse('file:///test/custom-mode.md'),
			name: 'Test Mode',
			description: 'A test custom mode',
			tools: ['tool1', 'tool2'],
			agentInstructions: { content: 'Custom mode body', toolReferences: [] },
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		promptsService.setCustomModes([customMode]);

		await waitForRefresh();

		const modes = await chatModeService.getLocalModes();

		// TUNGSTEN: anpassade lagen lases fortfarande in (handelsen nedan fyrar,
		// se nasta test), men de OFFERERAS aldrig. De ar agent-lagets
		// utbyggnadspunkt, och utan agent-lage finns det inget att bygga ut --
		// ett anpassat lage i valjaren vore en "Custom Agents"-yta med ett annat
		// namn. Se getCustomModes() i chatModes.ts.
		assert.strictEqual(modes.custom.length, 0);
		assert.strictEqual(modes.findModeById(customMode.uri.toString()), undefined);
	});

	test('should fire change event when custom modes are updated', async () => {
		let eventFired = false;
		testDisposables.add((await chatModeService.getLocalModes()).onDidChange(() => {
			eventFired = true;
		}));

		const customMode: ICustomAgent = {
			id: 'custom-mode',
			uri: URI.parse('file:///test/custom-mode.md'),
			name: 'Test Mode',
			description: 'A test custom mode',
			tools: [],
			agentInstructions: { content: 'Custom mode body', toolReferences: [] },
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		promptsService.setCustomModes([customMode]);

		await waitForRefresh();

		assert.ok(eventFired);
	});

	test('TUNGSTEN: custom modes cannot be reached by id either', async () => {
		// Upstream slog upp instansen direkt i _customModeInstances, forbi
		// getCustomModes(). Foljden var att ett anpassat lage gick att na VIA ID
		// aven nar det inte offererades -- en aterstalld session som mindes ett
		// lage-id hade fatt tillbaka det. Se findModeById() i chatModes.ts.
		const customMode: ICustomAgent = {
			id: 'findable-mode',
			uri: URI.parse('file:///test/findable-mode.md'),
			name: 'Findable Mode',
			description: 'A findable custom mode',
			tools: [],
			agentInstructions: { content: 'Findable mode body', toolReferences: [] },
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		promptsService.setCustomModes([customMode]);

		await waitForRefresh();

		const modes = await chatModeService.getLocalModes();
		assert.strictEqual(modes.findModeById(customMode.uri.toString()), undefined, 'reachable by uri');
		assert.strictEqual(modes.findModeById(customMode.id), undefined, 'reachable by id');
		assert.strictEqual(modes.findModeByName(customMode.name), undefined, 'reachable by name');
	});

	test('should update existing custom mode instances when data changes', async () => {
		const uri = URI.parse('file:///test/updateable-mode.md');
		const initialMode: ICustomAgent = {
			id: 'updateable-mode',
			uri,
			name: 'Initial Mode',
			description: 'Initial description',
			tools: ['tool1'],
			agentInstructions: { content: 'Initial body', toolReferences: [] },
			model: ['gpt-4'],
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		// TUNGSTEN: uppdateringen av instanserna sker fortfarande (bokforingen ar
		// orord), men den ar inte langre observerbar genom det publika API:t --
		// custom ar alltid tom. Det som testas har ar darfor att en UPPDATERING
		// inte oppnar en bakvag: oavsett hur manga gangor prompt-tjansten byter
		// data far inget lage sippra ut i valjaren eller i uppslagen.
		promptsService.setCustomModes([initialMode]);
		await waitForRefresh();

		assert.strictEqual((await chatModeService.getLocalModes()).custom.length, 0);

		const updatedMode: ICustomAgent = {
			...initialMode,
			description: 'Updated description',
			tools: ['tool1', 'tool2'],
			agentInstructions: { content: 'Updated body', toolReferences: [] },
			model: ['Updated model']
		};

		promptsService.setCustomModes([updatedMode]);
		await waitForRefresh();

		const updatedModes = await chatModeService.getLocalModes();
		assert.strictEqual(updatedModes.custom.length, 0);
		assert.strictEqual(updatedModes.findModeById(uri.toString()), undefined);
		assert.deepStrictEqual(updatedModes.builtin.map(m => m.id), [ChatModeKind.Ask]);
	});

	test('should not fire change event when custom mode payload is unchanged', async () => {
		const baseMode: ICustomAgent = {
			id: 'stable-mode',
			uri: URI.parse('file:///test/stable-mode.md'),
			name: 'Stable Mode',
			description: 'Stable description',
			tools: ['tool1'],
			agentInstructions: { content: 'Stable body', toolReferences: [] },
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		promptsService.setCustomModes([baseMode]);
		await waitForRefresh();

		let eventCount = 0;
		testDisposables.add((await chatModeService.getLocalModes()).onDidChange(() => {
			eventCount++;
		}));

		const equivalentMode: ICustomAgent = {
			...baseMode,
			tools: [...(baseMode.tools ?? [])],
			agentInstructions: {
				content: baseMode.agentInstructions.content,
				toolReferences: [...baseMode.agentInstructions.toolReferences],
			},
			visibility: { ...baseMode.visibility },
		};

		promptsService.setCustomModes([equivalentMode]);
		await waitForRefresh();

		assert.strictEqual(eventCount, 0);
	});

	test('should remove custom modes that no longer exist', async () => {
		const mode1: ICustomAgent = {
			id: 'mode1',
			uri: URI.parse('file:///test/mode1.md'),
			name: 'Mode 1',
			description: 'First mode',
			tools: [],
			agentInstructions: { content: 'Mode 1 body', toolReferences: [] },
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		const mode2: ICustomAgent = {
			id: 'mode2',
			uri: URI.parse('file:///test/mode2.md'),
			name: 'Mode 2',
			description: 'Second mode',
			tools: [],
			agentInstructions: { content: 'Mode 2 body', toolReferences: [] },
			source: workspaceSource,
			target: Target.Undefined,
			visibility: { userInvocable: true, agentInvocable: true },
			enabled: true
		};

		// TUNGSTEN: hur manga lagen prompt-tjansten an rapporterar, och hur de an
		// laggs till eller tas bort, ar svaret alltid noll offererade lagen.
		promptsService.setCustomModes([mode1, mode2]);
		await waitForRefresh();

		let modes = await chatModeService.getLocalModes();
		assert.strictEqual(modes.custom.length, 0);

		promptsService.setCustomModes([mode1]);
		await waitForRefresh();

		modes = await chatModeService.getLocalModes();
		assert.strictEqual(modes.custom.length, 0);
		assert.strictEqual(modes.findModeById(mode1.uri.toString()), undefined);
	});

});
