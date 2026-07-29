/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatModeKind, RawChatParticipantLocation } from '../constants.js';

export interface IRawChatCommandContribution {
	name: string;
	description: string;
	sampleRequest?: string;
	isSticky?: boolean;
	when?: string;
	disambiguation?: { category: string; categoryName?: string /** Deprecated */; description: string; examples: string[] }[];
}

export interface IRawChatParticipantContribution {
	id: string;
	name: string;
	fullName: string;
	when?: string;
	description?: string;
	isDefault?: boolean;
	isSticky?: boolean;
	sampleRequest?: string;
	commands?: IRawChatCommandContribution[];
	locations?: RawChatParticipantLocation[];
	/**
	 * Valid for default participants in 'panel' location
	 */
	modes?: ChatModeKind[];
	disambiguation?: { category: string; categoryName?: string /** Deprecated */; description: string; examples: string[] }[];
}

/**
 * Hardcoding the previous id of the Copilot Chat provider to avoid breaking view locations, persisted data, etc.
 * DON'T use this for any new data, only for old persisted data.
 * @deprecated
 *
 * TUNGSTEN: konstanten star kvar som 'copilot', och det ar ett MEDVETET val
 * som omprovats.
 *
 * Den ar INTE en Copilot-yta. Den ar en persistensnyckel, den syns aldrig i
 * granssnittet, och den chattvy den namnger ar Freyas egen lokala guide --
 * vyns anvandarsynliga namn ar "Chat" (chatParticipant.contribution.ts).
 * De fyra kommandona workbench.panel.chat.view.copilot.* ar VS Codes
 * auto-genererade vy-kommandon (fokusera, vaxla, ...) for just den vyn.
 *
 * ATT DOPA OM DEN SKULLE SLA SONDER TRE SAKER, alla anvandardata:
 *
 *   ChatViewId = `workbench.panel.chat.view.${CHAT_PROVIDER_ID}`
 *     Vy-id:t. Var vyn ligger, hur stor den ar och om den ar synlig lagras
 *     under det id:t -- ett byte flyttar tillbaka chatten till standardlaget
 *     for alla som redan flyttat den.        (browser/chat.ts)
 *
 *   new Memento(`interactive-session-view-${CHAT_PROVIDER_ID}`, ...)
 *     Vyns eget sparade tillstand.           (viewPane/chatViewPane.ts)
 *
 *   locationKey = CHAT_PROVIDER_ID
 *     Nyckeln som chattens INMATNINGSHISTORIK ligger under. Ett byte
 *     tommer historiken.                     (chatWidgetHistoryService.ts)
 *
 * Priset for ett kosmetiskt strangbyte i en fil ingen anvandare ser vore
 * alltsa tre sorters forlorat tillstand vid uppgradering. Lat den vara.
 */
export const CHAT_PROVIDER_ID = 'copilot';
