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

export function chatBackend(): Backend {
  return cfg().get<Backend>("chat.backend") ?? "ollama";
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
