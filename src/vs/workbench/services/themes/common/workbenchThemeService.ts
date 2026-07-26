/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Dark 2026';
	// Tungsten default: warm cream/beige. 'Light 2026' stays in the picker.
	export const COLOR_THEME_LIGHT = 'Tungsten Cream';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#0078D4',
	'activityBar.background': '#181818',
	'activityBar.border': '#2B2B2B',
	'activityBar.foreground': '#D7D7D7',
	'activityBar.inactiveForeground': '#868686',
	'activityBarBadge.background': '#0078D4',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#616161',
	'badge.foreground': '#F8F8F8',
	'button.background': '#0078D4',
	'button.border': '#FFFFFF12',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#026EC1',
	'button.secondaryBackground': '#313131',
	'button.secondaryForeground': '#CCCCCC',
	'button.secondaryHoverBackground': '#3C3C3C',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#85B6FF',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#313131',
	'checkbox.border': '#3C3C3C',
	'debugToolBar.background': '#181818',
	'descriptionForeground': '#9D9D9D',
	'dropdown.background': '#313131',
	'dropdown.border': '#3C3C3C',
	'dropdown.foreground': '#CCCCCC',
	'dropdown.listBackground': '#1F1F1F',
	'editor.background': '#1F1F1F',
	'editor.findMatchBackground': '#9E6A03',
	'editor.foreground': '#CCCCCC',
	'editor.inactiveSelectionBackground': '#3A3D41',
	'editor.selectionHighlightBackground': '#ADD6FF26',
	'editorGroup.border': '#FFFFFF17',
	'editorGroupHeader.tabsBackground': '#181818',
	'editorGroupHeader.tabsBorder': '#2B2B2B',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#0078D4',
	'editorIndentGuide.activeBackground1': '#707070',
	'editorIndentGuide.background1': '#404040',
	'editorLineNumber.activeForeground': '#CCCCCC',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#010409',
	'editorWidget.background': '#202020',
	'errorForeground': '#F85149',
	'focusBorder': '#0078D4',
	'foreground': '#CCCCCC',
	'icon.foreground': '#CCCCCC',
	'input.background': '#313131',
	'input.border': '#3C3C3C',
	'input.foreground': '#CCCCCC',
	'input.placeholderForeground': '#989898',
	'inputOption.activeBackground': '#2489DB82',
	'inputOption.activeBorder': '#2488DB',
	'keybindingLabel.foreground': '#CCCCCC',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#383B3D',
	'menu.background': '#1F1F1F',
	'menu.border': '#454545',
	'menu.foreground': '#CCCCCC',
	'menu.selectionBackground': '#0078d4',
	'menu.separatorBackground': '#454545',
	'notificationCenterHeader.background': '#1F1F1F',
	'notificationCenterHeader.foreground': '#CCCCCC',
	'notifications.background': '#1F1F1F',
	'notifications.border': '#2B2B2B',
	'notifications.foreground': '#CCCCCC',
	'panel.background': '#181818',
	'panel.border': '#2B2B2B',
	'panelInput.border': '#2B2B2B',
	'panelTitle.activeBorder': '#0078D4',
	'panelTitle.activeForeground': '#CCCCCC',
	'panelTitle.inactiveForeground': '#9D9D9D',
	'peekViewEditor.background': '#1F1F1F',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#1F1F1F',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#3C3C3C',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#0078D4',
	'quickInput.background': '#222222',
	'quickInput.foreground': '#CCCCCC',
	'settings.dropdownBackground': '#313131',
	'settings.dropdownBorder': '#3C3C3C',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#BB800966',
	'sideBar.background': '#181818',
	'sideBar.border': '#2B2B2B',
	'sideBar.foreground': '#CCCCCC',
	'sideBarSectionHeader.background': '#181818',
	'sideBarSectionHeader.border': '#2B2B2B',
	'sideBarSectionHeader.foreground': '#CCCCCC',
	'sideBarTitle.foreground': '#CCCCCC',
	'statusBar.background': '#181818',
	'statusBar.border': '#2B2B2B',
	'statusBar.debuggingBackground': '#0078D4',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#0078D4',
	'statusBar.foreground': '#CCCCCC',
	'statusBar.noFolderBackground': '#1F1F1F',
	'statusBarItem.focusBorder': '#0078D4',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#0078D4',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#1F1F1F',
	'tab.activeBorder': '#1F1F1F',
	'tab.activeBorderTop': '#0078D4',
	'tab.activeForeground': '#FFFFFF',
	'tab.border': '#2B2B2B',
	'tab.hoverBackground': '#1F1F1F',
	'tab.inactiveBackground': '#181818',
	'tab.inactiveForeground': '#9D9D9D',
	'tab.lastPinnedBorder': '#ccc3',
	'tab.selectedBackground': '#37373D',
	'tab.selectedBorderTop': '#6caddf',
	'tab.selectedForeground': '#FFFFFF',
	'tab.unfocusedActiveBorder': '#1F1F1F',
	'tab.unfocusedActiveBorderTop': '#2B2B2B',
	'tab.unfocusedHoverBackground': '#1F1F1F',
	'terminal.foreground': '#CCCCCC',
	'terminal.inactiveSelectionBackground': '#3A3D41',
	'terminal.tab.activeBorder': '#0078D4',
	'textBlockQuote.background': '#2B2B2B',
	'textBlockQuote.border': '#616161',
	'textCodeBlock.background': '#2B2B2B',
	'textLink.activeForeground': '#4daafc',
	'textLink.foreground': '#4daafc',
	'textPreformat.background': '#3C3C3C',
	'textPreformat.foreground': '#D0D0D0',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#181818',
	'titleBar.activeForeground': '#CCCCCC',
	'titleBar.border': '#2B2B2B',
	'titleBar.inactiveBackground': '#1F1F1F',
	'titleBar.inactiveForeground': '#9D9D9D',
	'welcomePage.progress.foreground': '#0078D4',
	'welcomePage.tileBackground': '#2B2B2B',
	'widget.border': '#313131'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#E3D8C1',
	'activityBar.activeBorder': '#C15F3C',
	'activityBar.background': '#EFE7D7',
	'activityBar.border': '#DED2B8',
	'activityBar.foreground': '#2A2724',
	'activityBar.inactiveForeground': '#918879',
	'activityBarBadge.background': '#C15F3C',
	'activityBarBadge.foreground': '#FFF9F2',
	'badge.background': '#DED2B8',
	'badge.foreground': '#3B3733',
	'button.background': '#C15F3C',
	'button.border': '#00000000',
	'button.foreground': '#FFF9F2',
	'button.hoverBackground': '#9A4526',
	'button.secondaryBackground': '#DED2B8',
	'button.secondaryForeground': '#3B3733',
	'button.secondaryHoverBackground': '#DED2B8',
	'chat.slashCommandBackground': '#EDE2D0',
	'chat.slashCommandForeground': '#8F4227',
	'chat.editedFileForeground': '#8A6D1B',
	'checkbox.background': '#EFE7D7',
	'checkbox.border': '#D3C5A8',
	'descriptionForeground': '#3B3733',
	'diffEditor.unchangedRegionBackground': '#EFE7D7',
	'dropdown.background': '#F4EEE2',
	'dropdown.border': '#D3C5A8',
	'dropdown.foreground': '#3B3733',
	'dropdown.listBackground': '#F4EEE2',
	'editor.background': '#F4EEE2',
	'editor.foreground': '#3B3733',
	'editor.inactiveSelectionBackground': '#E8DCC9',
	'editor.selectionHighlightBackground': '#E5D7C0AA',
	'editorGroup.border': '#DED2B8',
	'editorGroupHeader.tabsBackground': '#EFE7D7',
	'editorGroupHeader.tabsBorder': '#DED2B8',
	'editorGutter.addedBackground': '#6E8B3D',
	'editorGutter.deletedBackground': '#A3402B',
	'editorGutter.modifiedBackground': '#C15F3C',
	'editorIndentGuide.activeBackground1': '#C9B996',
	'editorIndentGuide.background1': '#E2D7C2',
	'editorLineNumber.activeForeground': '#6B635A',
	'editorLineNumber.foreground': '#A79D8C',
	'editorOverviewRuler.border': '#DED2B8',
	'editorSuggestWidget.background': '#EFE7D7',
	'editorWidget.background': '#EFE7D7',
	'errorForeground': '#A3402B',
	'focusBorder': '#C15F3C',
	'foreground': '#3B3733',
	'icon.foreground': '#3B3733',
	'input.background': '#F4EEE2',
	'input.border': '#D3C5A8',
	'input.foreground': '#3B3733',
	'input.placeholderForeground': '#918879',
	'inputOption.activeBackground': '#E3D3C2',
	'inputOption.activeBorder': '#C15F3C',
	'inputOption.activeForeground': '#2A2724',
	'keybindingLabel.foreground': '#3B3733',
	'list.activeSelectionBackground': '#E3D8C1',
	'list.activeSelectionForeground': '#2A2724',
	'list.activeSelectionIconForeground': '#2A2724',
	'list.focusAndSelectionOutline': '#C15F3C',
	'list.hoverBackground': '#E9E0CD',
	'menu.border': '#D3C5A8',
	'menu.selectionBackground': '#C15F3C',
	'menu.selectionForeground': '#FFF9F2',
	'notebook.cellBorderColor': '#DED2B8',
	'notebook.selectedCellBackground': '#EFE8D9',
	'notificationCenterHeader.background': '#F4EEE2',
	'notificationCenterHeader.foreground': '#3B3733',
	'notifications.background': '#F4EEE2',
	'notifications.border': '#DED2B8',
	'notifications.foreground': '#3B3733',
	'panel.background': '#EFE7D7',
	'panel.border': '#DED2B8',
	'panelInput.border': '#DED2B8',
	'panelTitle.activeBorder': '#C15F3C',
	'panelTitle.activeForeground': '#3B3733',
	'panelTitle.inactiveForeground': '#3B3733',
	'peekViewEditor.matchHighlightBackground': '#E8B98F',
	'peekViewResult.background': '#F4EEE2',
	'peekViewResult.matchHighlightBackground': '#E8B98F',
	'pickerGroup.border': '#DED2B8',
	'pickerGroup.foreground': '#918879',
	'ports.iconRunningProcessForeground': '#5C6B2E',
	'progressBar.background': '#C15F3C',
	'quickInput.background': '#EFE7D7',
	'quickInput.foreground': '#3B3733',
	'searchEditor.textInputBorder': '#D3C5A8',
	'settings.dropdownBackground': '#F4EEE2',
	'settings.dropdownBorder': '#D3C5A8',
	'settings.headerForeground': '#2A2724',
	'settings.modifiedItemIndicator': '#E8B98F',
	'settings.numberInputBorder': '#D3C5A8',
	'settings.textInputBorder': '#D3C5A8',
	'sideBar.background': '#EFE7D7',
	'sideBar.border': '#DED2B8',
	'sideBar.foreground': '#3B3733',
	'sideBarSectionHeader.background': '#EFE7D7',
	'sideBarSectionHeader.border': '#DED2B8',
	'sideBarSectionHeader.foreground': '#3B3733',
	'sideBarTitle.foreground': '#3B3733',
	'statusBar.background': '#EFE7D7',
	'statusBar.border': '#DED2B8',
	'statusBar.debuggingBackground': '#C15F3C',
	'statusBar.debuggingForeground': '#2A2724',
	'statusBar.focusBorder': '#C15F3C',
	'statusBar.foreground': '#3B3733',
	'statusBar.noFolderBackground': '#EFE7D7',
	'statusBarItem.compactHoverBackground': '#DED2B8',
	'statusBarItem.errorBackground': '#A3402B',
	'statusBarItem.focusBorder': '#C15F3C',
	'statusBarItem.hoverBackground': '#D9CCB0',
	'statusBarItem.prominentBackground': '#C15F3C',
	'statusBarItem.remoteBackground': '#C15F3C',
	'statusBarItem.remoteForeground': '#FFF9F2',
	'tab.activeBackground': '#F4EEE2',
	'tab.activeBorder': '#EFE7D7',
	'tab.activeBorderTop': '#C15F3C',
	'tab.activeForeground': '#3B3733',
	'tab.border': '#DED2B8',
	'tab.hoverBackground': '#F4EEE2',
	'tab.inactiveBackground': '#EFE7D7',
	'tab.inactiveForeground': '#918879',
	'tab.lastPinnedBorder': '#D3C5A8',
	'tab.selectedBackground': '#E7DCC6',
	'tab.selectedBorderTop': '#C9B996',
	'tab.selectedForeground': '#2A2724',
	'tab.unfocusedActiveBorder': '#EFE7D7',
	'tab.unfocusedActiveBorderTop': '#DED2B8',
	'tab.unfocusedHoverBackground': '#EFE7D7',
	'terminal.foreground': '#3B3733',
	'terminal.inactiveSelectionBackground': '#E8DCC9',
	'terminal.tab.activeBorder': '#C15F3C',
	'terminalCursor.foreground': '#C15F3C',
	'textBlockQuote.background': '#EFE7D7',
	'textBlockQuote.border': '#DED2B8',
	'textCodeBlock.background': '#EFE7D7',
	'textLink.activeForeground': '#C15F3C',
	'textLink.foreground': '#C15F3C',
	'textPreformat.background': '#EDE2D0',
	'textPreformat.foreground': '#3B3733',
	'textSeparator.foreground': '#DED2B8',
	'titleBar.activeBackground': '#EFE7D7',
	'titleBar.activeForeground': '#2A2724',
	'titleBar.border': '#DED2B8',
	'titleBar.inactiveBackground': '#EFE7D7',
	'titleBar.inactiveForeground': '#918879',
	'welcomePage.tileBackground': '#EFE7D7',
	'widget.border': '#DED2B8'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
