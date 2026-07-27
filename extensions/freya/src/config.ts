// Var Freya hämtar sin modellkonfiguration ifrån, och i vilken ordning.
//
// BYOK och local-first: nycklar bor i VS Codes SecretStorage (OS-nyckelringen),
// aldrig i settings.json och aldrig i repot. .env i workspace-roten stöds för
// att det redan är hur CLI:n körs, men SecretStorage vinner.
import * as vscode from "vscode";
import * as path from "path";
import { readEnvFile } from "./core/env.js";
import type { ModelProvider } from "./core/providers/types.js";
import { WorkersAIProvider } from "./core/providers/workersai.js";
import { OllamaProvider } from "./core/providers/ollama.js";

export const SECRET_ACCOUNT_ID = "freya.cloudflareAccountId";
export const SECRET_API_TOKEN = "freya.cloudflareApiToken";

export type Backend = "workersai" | "ollama";

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

/**
 * ARBETSFÖRDELNINGEN, i kod.
 *
 * Lätt lane (autocomplete, commit-rubriker, förklaringar) = den INBÄDDADE
 * 1.5B:n. Den följer med appen, kräver ingen installation och kostar noll, så
 * den är default och nästan alltid tillgänglig.
 *
 * Tung lane (agent-loopen, flera filer, djupt resonemang) = moln. Ingen tung
 * LOKAL modell krävs; en lokal 14B via Ollama är ett tillval för den som har
 * hårdvaran.
 */
export type LightBackend = "embedded" | "ollama";
export type ChatBackendSetting = Backend | "auto";

export function lightBackend(): LightBackend {
  return cfg().get<LightBackend>("light.backend") ?? "embedded";
}

/**
 * Cachead ögonblicksbild av "finns molnnycklar?".
 *
 * chatBackend() MÅSTE vara synkron: den anropas från participant.ts, som inte
 * ska behöva ändras för att routningen blev smartare. Nycklarna bor i
 * SecretStorage och läses asynkront, så svaret cachas här och uppdateras vid
 * uppstart och när nycklarna ändras.
 */
let cloudKeysAvailable = false;

export async function refreshCloudKeyState(
  ctx: vscode.ExtensionContext
): Promise<boolean> {
  const env = await envFromWorkspace();
  const accountId = await resolveSecret(ctx, SECRET_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID", env);
  const apiToken = await resolveSecret(ctx, SECRET_API_TOKEN, "CLOUDFLARE_API_TOKEN", env);
  cloudKeysAvailable = !!accountId && !!apiToken;
  return cloudKeysAvailable;
}

export function hasCloudKeys(): boolean {
  return cloudKeysAvailable;
}

export function chatBackendSetting(): ChatBackendSetting {
  return cfg().get<ChatBackendSetting>("chat.backend") ?? "auto";
}

/**
 * Vilken TUNG backend som gäller nu. "auto" väljer moln när nycklar finns och
 * annars den valfria lokala Ollama-modellen — så appen pekar på något som
 * faktiskt kan svara i stället för att kräva ett val av användaren.
 */
export function chatBackend(): Backend {
  const setting = chatBackendSetting();
  if (setting === "workersai" || setting === "ollama") {
    return setting;
  }
  return cloudKeysAvailable ? "workersai" : "ollama";
}

export function ollamaUrl(): string {
  return cfg().get<string>("ollama.url") || "http://localhost:11434";
}

/** Ollama-modellen som chatt/agent använder. */
export function chatModel(): string {
  return cfg().get<string>("chat.ollamaModel") || "qwen2.5-coder:14b";
}

/** FIM-modellen som autocomplete använder. Alltid lokal. */
export function autocompleteModel(): string {
  return cfg().get<string>("autocomplete.model") || "qwen2.5-coder:1.5b-base";
}

/**
 * Modellen som skriver commit-meddelanden. Alltid Ollama, aldrig molnet.
 * Default är samma modell som chatten: att skriva ett commit-meddelande är att
 * följa en instruktion, och FIM-modellen i autocomplete är en base-modell som
 * inte kan det -- den skulle fortsätta diffen i stället för att sammanfatta den.
 */
export function commitModel(): string {
  return cfg().get<string>("commit.model") || chatModel();
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function envFromWorkspace(): Promise<Record<string, string>> {
  const root = workspaceRoot();
  if (!root) return {};
  return readEnvFile(path.join(root, ".env"));
}

// SecretStorage -> workspace .env -> process.env. Frågar INTE användaren här;
// den som anropar avgör om det är läge att visa en prompt.
async function resolveSecret(
  ctx: vscode.ExtensionContext,
  secretKey: string,
  envKey: string,
  env: Record<string, string>
): Promise<string | undefined> {
  const stored = await ctx.secrets.get(secretKey);
  if (stored) return stored;
  return env[envKey] || process.env[envKey] || undefined;
}

export async function promptAndStoreKeys(
  ctx: vscode.ExtensionContext
): Promise<boolean> {
  const accountId = await vscode.window.showInputBox({
    title: "Freya: Cloudflare Account ID",
    prompt: "Sparas i VS Codes SecretStorage, inte i settings.json.",
    ignoreFocusOut: true,
  });
  if (!accountId) return false;

  const apiToken = await vscode.window.showInputBox({
    title: "Freya: Cloudflare API Token",
    prompt: "Behöver behörigheten Workers AI. Sparas i SecretStorage.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!apiToken) return false;

  await ctx.secrets.store(SECRET_ACCOUNT_ID, accountId.trim());
  await ctx.secrets.store(SECRET_API_TOKEN, apiToken.trim());
  return true;
}

export async function clearKeys(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(SECRET_ACCOUNT_ID);
  await ctx.secrets.delete(SECRET_API_TOKEN);
}

export interface ProviderResult {
  provider?: ModelProvider;
  // Om provider saknas: en förklaring att visa i chatten i stället.
  problem?: string;
  label: string;
}

export async function createChatProvider(
  ctx: vscode.ExtensionContext
): Promise<ProviderResult> {
  const backend = chatBackend();

  if (backend === "ollama") {
    const url = ollamaUrl();
    const model = chatModel();
    return {
      provider: new OllamaProvider(url, model),
      label: `Ollama · ${model}`,
    };
  }

  const env = await envFromWorkspace();
  const accountId = await resolveSecret(
    ctx,
    SECRET_ACCOUNT_ID,
    "CLOUDFLARE_ACCOUNT_ID",
    env
  );
  const apiToken = await resolveSecret(
    ctx,
    SECRET_API_TOKEN,
    "CLOUDFLARE_API_TOKEN",
    env
  );

  if (!accountId || !apiToken) {
    return {
      label: "Workers AI",
      problem:
        "Workers AI saknar nycklar. Kör kommandot **Freya: Ange Cloudflare-nycklar** " +
        "(Ctrl+Shift+P) — de sparas i OS-nyckelringen.\n\n" +
        "Vill du köra helt lokalt i stället: sätt `freya.chat.backend` till `ollama`.",
    };
  }

  const model =
    cfg().get<string>("chat.workersAiModel") || "@cf/qwen/qwen3-30b-a3b-fp8";
  return {
    provider: new WorkersAIProvider(accountId, apiToken, model),
    label: `Workers AI · ${model}`,
  };
}
