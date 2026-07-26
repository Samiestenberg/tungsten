// Dev-harness för agentkärnan, utan VS Code i vägen. Den här filen är enda
// stället där kärnan kan verifieras skarpt utan att starta hela workbenchen —
// det var så CLI:n användes innan agenten flyttade in i Tungsten, och den ska
// fortsätta fungera.
//
// Kör (efter "npm run gulp compile-extension:freya"):
//   cd extensions/freya
//   set AGENT_WORKDIR=<mapp>            (PowerShell: $env:AGENT_WORKDIR="...")
//   node out/cli.js "din fraga"
//
// Nycklar läses ur miljön eller ur .env i AGENT_WORKDIR.
import { createInterface } from "node:readline/promises";
import * as path from "node:path";
import { runAgent } from "./core/agent.js";
import { readEnvFile } from "./core/env.js";
import { WorkersAIProvider } from "./core/providers/workersai.js";
import { OllamaProvider } from "./core/providers/ollama.js";
import type { ModelProvider } from "./core/providers/types.js";

async function main(): Promise<void> {
  const workdir = process.env["AGENT_WORKDIR"] ?? process.cwd();
  const env = await readEnvFile(path.join(workdir, ".env"));
  const pick = (key: string) => process.env[key] || env[key];

  let provider: ModelProvider;
  if ((pick("PROVIDER") ?? "") === "ollama") {
    const model = pick("OLLAMA_MODEL") ?? "qwen2.5-coder:14b";
    provider = new OllamaProvider(
      pick("OLLAMA_URL") ?? "http://localhost:11434",
      model
    );
    console.log(`provider: ollama ${model}`);
  } else {
    const accountId = pick("CLOUDFLARE_ACCOUNT_ID");
    const apiToken = pick("CLOUDFLARE_API_TOKEN");
    if (!accountId || !apiToken) {
      console.error(
        "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN saknas (miljon eller .env i AGENT_WORKDIR)."
      );
      process.exit(1);
    }
    const model = pick("WORKERS_AI_MODEL") ?? "@cf/qwen/qwen3-30b-a3b-fp8";
    provider = new WorkersAIProvider(accountId, apiToken, model);
    console.log(`provider: workers ai ${model}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let streaming = false;
  const onEvent = (e: any) => {
    if (e.type === "delta") {
      if (!streaming) {
        process.stdout.write("\n");
        streaming = true;
      }
      process.stdout.write(e.text);
    }
    if (e.type === "text") console.log("\n" + e.text);
    if (e.type === "tool") {
      console.log(`\n  -> ${e.name}(${JSON.stringify(e.input).slice(0, 80)})`);
    }
    if (e.type === "done" && streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };

  const askConfirm = async (command: string): Promise<boolean> => {
    const answer = await rl.question(`\n  Kor kommando?\n    ${command}\n  [j/N] `);
    return answer.trim().toLowerCase() === "j";
  };

  console.log(`workdir: ${workdir}`);
  console.log('Chatt igang. "exit" avslutar.\n');

  // Vid pipe:ad stdin stänger readline sig själv vid EOF, ofta mitt under en
  // körning. Utan detta kastar nästa question() ERR_USE_AFTER_CLOSE.
  let stdinClosed = false;
  rl.on("close", () => {
    stdinClosed = true;
  });

  let pending = process.argv.slice(2).join(" ").trim();
  for (;;) {
    let input = pending;
    pending = "";
    if (!input) {
      if (stdinClosed) break;
      try {
        input = (await rl.question("\n> ")).trim();
      } catch {
        break; // stdin stängd
      }
    }
    if (!input) continue;
    if (["exit", "quit", "avsluta"].includes(input.toLowerCase())) break;

    try {
      await runAgent({
        provider,
        prompt: input,
        workdir,
        confirm: askConfirm,
        onEvent,
      });
    } catch (err: any) {
      console.error("\nFEL: " + String(err?.message ?? err));
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
