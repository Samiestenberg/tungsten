// Minimal .env-läsare. Ersätter dotenv — en inbyggd extension ska inte dra in
// runtime-beroenden. Läser bara, muterar aldrig process.env.
import { readFile } from "node:fs/promises";

export type EnvMap = Record<string, string>;

export async function readEnvFile(path: string): Promise<EnvMap> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return {}; // ingen .env är ett helt normalt läge
  }
  return parseEnv(raw);
}

export function parseEnv(raw: string): EnvMap {
  const out: EnvMap = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();

    // Ta bort omgivande citattecken; expandera \n bara i dubbelcitat.
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}
