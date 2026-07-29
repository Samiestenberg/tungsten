/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAttachPromptActions } from './attachInstructionsAction.js';
import { registerRunPromptActions } from './runPromptAction.js';
import { registerNewPromptFileActions } from './newPromptFileActions.js';
import { registerSkillActions } from './skillActions.js';
import { registerHookActions } from './hookActions.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SaveAsAgentFileAction, SaveAsInstructionsFileAction, SaveAsPromptFileAction } from './saveAsPromptFileActions.js';


/**
 * Helper to register all actions related to reusable prompt files.
 */
export function registerPromptActions(): void {
	registerRunPromptActions();
	registerAttachPromptActions();
	registerSkillActions();
	registerHookActions();
	registerAction2(SaveAsPromptFileAction);
	registerAction2(SaveAsInstructionsFileAction);
	registerAction2(SaveAsAgentFileAction);
	// TUNGSTEN: registerAgentActions() anropas INTE.
	//
	// Den registrerade fyra "Configure Custom Agents..."-actions: tva i
	// lagesvaljaren (MenuId.ChatModePicker) och tva i chattens
	// konfigurationsmeny. Alla fyra syntes i det packade bygget.
	//
	// Ingangen ar neutraliserad har i stallet for att actionsen tas bort ur
	// chatModeActions.ts. Skalet: en oregistrerad action ar helt onabar -- den
	// finns varken i paletten, i menyer eller via executeCommand -- medan en
	// halv borttagning latt lamnar en dod knapp kvar nagonstans. Filen ar orord
	// och redo om nagon vill vacka agent-lagen igen.
	registerNewPromptFileActions();
}
