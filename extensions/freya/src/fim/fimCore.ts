// Delad FIM-kärna för 1.5B-lanen.
//
// Allt i den här mappen är REN fill-in-the-middle: prefix = koden före luckan,
// suffix = koden efter, och modellen fyller luckan. Ingen instruktion, inget
// omdöme, ingen prosa. Testet för om en funktion hör hemma här:
//
//   "Behöver jag skriva en instruktion, eller fortsätter modellen bara det
//    som redan finns?"
//
// Fortsättning -> hit (1.5B, port 11435). Instruktion -> instruct-lanen (3B,
// port 11436). Gränsen suddas aldrig ut för att spara en modell.
//
// Insatsen vid en miss är låg med flit: allt här visas som ett förslag
// användaren kan ignorera eller trycka Esc på. Därför får 1.5B gissa.
import * as vscode from "vscode";
import { localInfill } from "../localModel.js";

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

/**
 * Qwens FIM-specialtokens. Modellen avslutar inte av sig själv -- utan de här
 * stoppen fortsätter den in i nästa "fil" och hittar på innehåll.
 */
export const FIM_STOP = [
  "<|fim_pad|>",
  "<|endoftext|>",
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|file_sep|>",
  "<|repo_name|>",
];

/** Specialtokens som ändå läckt in i texten hör inte hemma i användarens fil. */
export function cleanFimOutput(raw: string): string {
  return raw.replace(/<\|[^|]*\|>/g, "");
}

export interface FimRequest {
  prefix: string;
  suffix: string;
  maxTokens: number;
  /** Utöver FIM_STOP. T.ex. ["\n"] för enradsförslag. */
  stop?: string[];
  signal: AbortSignal;
}

/**
 * Ett FIM-anrop mot den INBÄDDADE 1.5B:n.
 *
 * undefined = ingen inbäddad modell (dev-träd utan runtime, eller
 * freya.light.backend satt till ollama). Anroparen avgör om det är läge att
 * falla tillbaka på Ollama; autocomplete gör det, de nyare ytorna gör det
 * inte -- de är tysta i stället, för ett uteblivet förslag är gratis.
 */
export async function runFim(req: FimRequest): Promise<string | undefined> {
  const out = await localInfill(req.prefix, req.suffix, {
    maxTokens: req.maxTokens,
    temperature: 0.1,
    stop: [...FIM_STOP, ...(req.stop ?? [])],
    signal: req.signal,
  });
  return out === undefined ? undefined : cleanFimOutput(out);
}

/**
 * Kontextfönstret runt en position. Samma budget för alla FIM-ytor, så en
 * höjning av freya.autocomplete.prefixChars gäller dem allihop.
 */
export function fimContext(
  document: vscode.TextDocument,
  offset: number
): { prefix: string; suffix: string } {
  const maxPrefix = cfg().get<number>("autocomplete.prefixChars") ?? 3000;
  const maxSuffix = cfg().get<number>("autocomplete.suffixChars") ?? 1000;
  const text = document.getText();
  return {
    prefix: text.slice(Math.max(0, offset - maxPrefix), offset),
    suffix: text.slice(offset, offset + maxSuffix),
  };
}

/** Ytor vi aldrig föreslår i: utdata-kanaler, differ, scm-input och liknande. */
export function isEditableDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" || document.uri.scheme === "untitled";
}

/**
 * Väntar ms millisekunder men ger upp direkt om anroparen avbryter.
 * VS Code avbryter föregående request när användaren skriver vidare, så det
 * ÄR debouncen -- ingen delad timer behövs.
 */
export function debounce(
  ms: number,
  token: vscode.CancellationToken
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(true);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(false);
    });
  });
}
