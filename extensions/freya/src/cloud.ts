// MOLN-TIERN. VILANDE. Inte nåbar i default-bygget.
//
// ─────────────────────────────────────────────────────────────────────────
// LÄS DET HÄR FÖRST
//
// Tungsten kör allt lokalt. Det är produktlöftet, inte en inställning: två
// modeller följer med i installern, de kör som barnprocesser mot 127.0.0.1,
// och default-bygget gör INGEN utgående nätverkstrafik för AI.
//
// Den här filen är den enda platsen i kodbasen som vet hur man pratar med
// Cloudflare Workers AI. Den är kvar för att beslutet om en framtida
// opt-in-moln-tier är PARKERAT, inte avslagit -- koden är granskad, den
// fungerade, och att kasta den för att sedan skriva den igen vore slöseri.
//
// Men den är AVSTÄNGD, och avstängningen sitter i en konstant och inte i en
// inställning:
//
//   * CLOUD_TIER_ENABLED är false. Ingen inställning, ingen miljövariabel och
//     ingen fientlig .vscode/settings.json kan sätta den till true. Det krävs
//     en kodändring och ett nytt bygge.
//   * Så länge den är false läser den här filen ALDRIG några
//     CLOUDFLARE_-uppgifter -- varken ur SecretStorage, ur .env eller ur
//     process.env. Grinden ligger FÖRST i varje funktion, före all läsning.
//     Det är skillnaden mellan "vi använder inte nycklarna" och "vi rör dem
//     inte".
//   * Ingenting i den aktiva kodvägen importerar den här filen. Den enda
//     importen är från cloud.test.ts, som verifierar att den är av.
//
// Vill man väcka den: sätt CLOUD_TIER_ENABLED till true, registrera
// registerCloudCommands() i extension.ts, och lägg tillbaka en
// modellvalsyta. Räkna med att privacy-texterna i README och i
// walkthrough:en måste skrivas om samtidigt -- de lovar noll utgående trafik.
// ─────────────────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import * as path from "path";
import { readEnvFile } from "./core/env.js";
import type { ModelProvider } from "./core/providers/types.js";
import { WorkersAIProvider } from "./core/providers/workersai.js";

/**
 * AV. Se filhuvudet.
 *
 * Typad som `false` med flit: TypeScript vet då att koden efter grinden är
 * onåbar, och varje försök att jämföra den mot true blir ett typfel i stället
 * för en tyst ändring.
 */
export const CLOUD_TIER_ENABLED: false = false;

export const SECRET_ACCOUNT_ID = "freya.cloudflareAccountId";
export const SECRET_API_TOKEN = "freya.cloudflareApiToken";

/** Modellen tiern skulle använda om den var på. */
const DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

async function envFromWorkspace(): Promise<Record<string, string>> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		return {};
	}
	return readEnvFile(path.join(root, ".env"));
}

// SecretStorage -> workspace .env -> process.env.
async function resolveSecret(
	ctx: vscode.ExtensionContext,
	secretKey: string,
	envKey: string,
	env: Record<string, string>
): Promise<string | undefined> {
	const stored = await ctx.secrets.get(secretKey);
	if (stored) {
		return stored;
	}
	return env[envKey] || process.env[envKey] || undefined;
}

/**
 * Moln-providern, eller undefined.
 *
 * GRINDEN LIGGER FÖRST, före varje läsning av nycklar. I default-bygget
 * returnerar den undefined utan att ha rört SecretStorage, .env eller
 * process.env en enda gång.
 */
export async function createCloudProvider(
	ctx: vscode.ExtensionContext
): Promise<ModelProvider | undefined> {
	if (!CLOUD_TIER_ENABLED) {
		return undefined;
	}

	// Onåbart i default-bygget. Kvar för att tiern ska gå att väcka utan att
	// skrivas om.
	const env = await envFromWorkspace();
	const accountId = await resolveSecret(ctx, SECRET_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID", env);
	const apiToken = await resolveSecret(ctx, SECRET_API_TOKEN, "CLOUDFLARE_API_TOKEN", env);
	if (!accountId || !apiToken) {
		return undefined;
	}
	return new WorkersAIProvider(accountId, apiToken, DEFAULT_MODEL);
}

/** Finns nycklar? Svarar false utan att läsa något när tiern är av. */
export async function hasCloudKeys(ctx: vscode.ExtensionContext): Promise<boolean> {
	if (!CLOUD_TIER_ENABLED) {
		return false;
	}
	const env = await envFromWorkspace();
	return (
		!!(await resolveSecret(ctx, SECRET_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID", env)) &&
		!!(await resolveSecret(ctx, SECRET_API_TOKEN, "CLOUDFLARE_API_TOKEN", env))
	);
}

/**
 * Kommandona för att lagra och radera nycklar.
 *
 * REGISTRERAS INTE i default-bygget -- extension.ts anropar inte den här
 * funktionen. Ett kommando som ber om molnnycklar hör inte hemma i en app som
 * lovar att inte prata med molnet, och ett registrerat kommando är synligt i
 * paletten oavsett om det gör något.
 */
export function registerCloudCommands(ctx: vscode.ExtensionContext): void {
	if (!CLOUD_TIER_ENABLED) {
		return;
	}

	ctx.subscriptions.push(
		vscode.commands.registerCommand("freya.setKeys", async () => {
			const accountId = await vscode.window.showInputBox({
				title: "Freya: Cloudflare Account ID",
				prompt: "Stored in VS Code SecretStorage, not in settings.json.",
				ignoreFocusOut: true,
			});
			if (!accountId) {
				return;
			}
			const apiToken = await vscode.window.showInputBox({
				title: "Freya: Cloudflare API Token",
				prompt: "Needs the Workers AI permission. Stored in SecretStorage.",
				password: true,
				ignoreFocusOut: true,
			});
			if (!apiToken) {
				return;
			}
			await ctx.secrets.store(SECRET_ACCOUNT_ID, accountId.trim());
			await ctx.secrets.store(SECRET_API_TOKEN, apiToken.trim());
		}),

		vscode.commands.registerCommand("freya.clearKeys", async () => {
			await ctx.secrets.delete(SECRET_ACCOUNT_ID);
			await ctx.secrets.delete(SECRET_API_TOKEN);
		})
	);
}
