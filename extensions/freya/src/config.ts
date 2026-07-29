// Var Freya hämtar sin modellkonfiguration ifrån.
//
// ARBETSFÖRDELNINGEN, i kod. TVÅ MODELLER, TVÅ ROLLER, båda lokala:
//
//   1.5B BASE, port 11435, alltid uppe (localServer.ts)
//     Allt som är "givet koden, fyll luckan / vad kommer härnäst": inline
//     completion, block, return, typsignaturer, next-edit, syntaxfix,
//     commit-rubriker. Ingen instruktion, inget omdöme. Hög frekvens.
//
//   3B INSTRUCT, port 11436, on-demand (instructServer.ts)
//     Allt som kräver att modellen läser en INSTRUKTION eller producerar
//     PROSA: förklara, inline edit, semantisk fix, tester, refaktorering,
//     namnförslag, granskning, guide-chatten. Låg frekvens.
//
// Testet för vilken lane en funktion hör till: "Behöver jag skriva en
// instruktion, eller fortsätter modellen bara det som redan finns?"
// Fortsättning -> 1.5B. Instruktion -> 3B. Gränsen suddas aldrig för att spara
// en modell.
//
// VAD SOM RETIRERADES OCH VARFÖR (FAS R):
//
//   qwen2.5-coder:14b via Ollama var den tunga lanens lokala val. Den krävde
//   att användaren hämtade 9 GB innan chatten fungerade -- alltså precis det
//   "ingen installation"-löftet som resten av appen bygger på. Borta som
//   default.
//
//   Workers AI (Cloudflare) var den tunga lanens molnval. Den krävde ett
//   konto, egna nycklar, och skickade koden ut ur maskinen. Borta som default.
//   KODEN ÄR KVAR men vilande i cloud.ts, bakom en konstant som inte går att
//   sätta från en inställning. Läs filhuvudet där.
//
// Kvar av Ollama finns EN sak: reserven för FIM-lanen (freya.light.backend =
// "ollama"), för den som hellre kör en egen liten modell än den inbäddade.
// Den är opt-in och rör inte instruct-lanen.
import * as vscode from "vscode";

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

/** Var den LÄTTA (FIM-)lanen hämtar sin modell. */
export type LightBackend = "embedded" | "ollama";

export function lightBackend(): LightBackend {
  return cfg().get<LightBackend>("light.backend") ?? "embedded";
}

/** Adressen till användarens egen Ollama. Används BARA av FIM-reserven. */
export function ollamaUrl(): string {
  return cfg().get<string>("ollama.url") || "http://localhost:11434";
}

/**
 * FIM-modellen i Ollama-reserven. Måste vara en BASE-modell: en instruct-modell
 * svarar med prosa om koden i stället för att fylla luckan.
 */
export function autocompleteModel(): string {
  return cfg().get<string>("autocomplete.model") || "qwen2.5-coder:1.5b-base";
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
