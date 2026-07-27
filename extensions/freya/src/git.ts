// Tunn brygga till den inbyggda git-extensionen.
//
// Vi typar bara det vi faktiskt använder i stället för att importera
// extensions/git/src/api/git.d.ts. Freya ska kunna byggas utan att vara
// beroende av git-extensionens interna sökvägar, och ytan vi rör är tre
// medlemmar stor.
import * as vscode from "vscode";

export interface GitInputBox {
  value: string;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: GitInputBox;
  /** cached=true ger `git diff --staged`. */
  diff(cached?: boolean): Promise<string>;
}

interface GitApi {
  readonly repositories: GitRepository[];
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
  readonly enabled: boolean;
}

/**
 * Hämtar git-API:t, eller undefined om git-extensionen är avstängd. Aktiverar
 * den vid behov -- den kan vara lazy och inte igång än när vårt kommando körs.
 */
export async function getGitApi(): Promise<GitApi | undefined> {
  const ext =
    vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) {
    return undefined;
  }
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports?.enabled) {
    return undefined;
  }
  return exports.getAPI(1);
}

/**
 * Väljer repo. Med flera repon i arbetsytan vinner det som innehåller den
 * aktiva filen; annars det första. `undefined` betyder inget git-repo alls.
 */
export async function pickRepository(
  preferred?: vscode.Uri
): Promise<GitRepository | undefined> {
  const api = await getGitApi();
  if (!api || api.repositories.length === 0) {
    return undefined;
  }
  const target = preferred ?? vscode.window.activeTextEditor?.document.uri;
  if (target) {
    const containing = api.repositories
      .filter((r) => target.fsPath.startsWith(r.rootUri.fsPath))
      // Längst rot vinner, så ett submodul-repo slår sitt föräldrarepo.
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    if (containing.length > 0) {
      return containing[0];
    }
  }
  return api.repositories[0];
}
