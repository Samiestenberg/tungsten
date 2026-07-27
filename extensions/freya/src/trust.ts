// Var gränsen för workspace trust går, på ETT ställe.
//
// BAKGRUNDEN: tillägget deklarerade untrustedWorkspaces.supported: false. Följden
// var att Freya inte aktiverades alls i en obetrodd mapp -- ingen inbäddad modell,
// ingen autocomplete, ingen förklaring till varför. En förstagångsanvändare som
// öppnar en nedladdad mapp fick en app som såg trasig ut. Tyst.
//
// UPPDELNINGEN: de två lanerna har helt olika riskprofil, så de behandlas olika.
//
//   LÄTTA lanen (autocomplete, commit-rubriker, förklaringar) LÄSER bara. Den
//   skickar text till en process vi själva startat på 127.0.0.1 och kör ingenting
//   ur arbetsytan. Den är därför på även i en obetrodd mapp. Förutsättningen är
//   att arbetsytan inte får peka om vart texten går eller vilken binär vi
//   startar -- se restrictedConfigurations i package.json, som spärrar
//   freya.local.runtimePath, freya.local.port och freya.ollama.url från
//   workspace-scope tills mappen litas på.
//
//   TUNGA lanen (agenten) skriver filer och kan köra kommandon via run_command.
//   Den är exakt det workspace trust finns för och är AV tills användaren litar
//   på mappen -- men den säger det, i stället för att bara utebli.
import * as vscode from "vscode";

/** VS Codes egen dialog för att lita på mappen. */
const TRUST_COMMAND = "workbench.trust.manage";

export function isTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

/**
 * Det agenten svarar med i stället för att vara tyst. MarkdownString med
 * isTrusted satt, annars renderar chatten inte kommandolänken som en knapp.
 */
export function agentPausedMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    "**Freya's agent is paused until you trust this folder.**\n\n" +
      "The agent can write files and run commands, so it stays off in a folder " +
      "you have not vouched for yet.\n\n" +
      "Still working in the meantime, all on the local model: inline completions, " +
      "commit messages, code explanations and the secret scanner.\n\n" +
      `[Trust this folder](command:${TRUST_COMMAND})`
  );
  // Utan detta blir kommandolänken en död länk.
  md.isTrusted = { enabledCommands: [TRUST_COMMAND] };
  return md;
}

/** Samma besked som ren text, för ytor som inte renderar markdown. */
export const AGENT_PAUSED_TEXT =
  "Freya's agent is paused until you trust this folder. " +
  "Run the command 'Workspaces: Manage Workspace Trust' to turn it on. " +
  "Autocomplete, commit messages and explanations keep working on the local model.";

export { TRUST_COMMAND };
