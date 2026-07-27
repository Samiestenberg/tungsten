import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Håller reda på vilka filer agenten faktiskt läst
const readFiles = new Set<string>();

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache",
  "coverage", ".wrangler", ".turbo", "out", ".venv", "__pycache__",
]);

async function walk(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  out: string[],
  cap: number
): Promise<void> {
  if (depth > maxDepth || out.length >= cap) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= cap) return;
    if (IGNORE.has(e.name)) continue;
    const full = resolve(dir, e.name);
    const rel = relative(root, full).replace(/\\/g, "/");
    if (e.isDirectory()) {
      out.push(rel + "/");
      await walk(full, root, depth + 1, maxDepth, out, cap);
    } else {
      out.push(rel);
    }
  }
}

// Hindrar agenten från att gå utanför projektmappen
function safePath(workdir: string, p: string): string {
  const full = resolve(workdir, p);
  const rel = relative(workdir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Sökväg utanför workdir: ${p}`);
  }
  return full;
}

// Filer som kan innehålla hemligheter — read_file vägrar läsa dessa.
// Exporterad så att hemlighets-skannern (../secrets.ts) använder SAMMA
// definition i stället för en egen kopia som glider isär från den här.
export const SECRET_FILE_PATTERN = /(^|[\\/])(\.env(\.|$)|\.dev\.vars$|[^\\/]+\.pem$)/i;

const READ_FILE_MAX_LINES = 2000;
const READ_FILE_MAX_CHARS = 60_000;
const RUN_COMMAND_MAX_CHARS = 20_000;

// Klipper stora filer så de inte spränger modellens kontext — vid rad- eller teckentaket, vad som slår först
function truncateFileContent(text: string): string {
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= READ_FILE_MAX_LINES && text.length <= READ_FILE_MAX_CHARS) {
    return text;
  }

  let shown = lines.slice(0, READ_FILE_MAX_LINES).join("\n");
  if (shown.length > READ_FILE_MAX_CHARS) {
    shown = shown.slice(0, READ_FILE_MAX_CHARS);
  }
  const shownLines = shown.split("\n").length;

  return (
    shown +
    `\n\n[avkortad: visade rad 1-${shownLines} av ${totalLines}. ` +
    `Använd run_command med findstr/select-string för att söka i resten.]`
  );
}

function truncateCommandOutput(text: string): string {
  if (text.length <= RUN_COMMAND_MAX_CHARS) return text;
  const shown = text.slice(0, RUN_COMMAND_MAX_CHARS);
  return (
    shown +
    `\n\n[avkortad: visade ${RUN_COMMAND_MAX_CHARS} av ${text.length} tecken. ` +
    `Använd findstr/select-string i kommandot för att söka i resten.]`
  );
}

export const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description: "Läs en fil relativt projektroten.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Skriv en fil. Skapar mappar vid behov. Skriver över befintlig fil.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Ändra en del av en fil. old_str måste finnas EXAKT en gång i filen — " +
      "ta med tillräckligt med omgivande rader för att den ska bli unik. " +
      "Läs filen först. Använd detta i stället för write_file på befintliga filer.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        old_str: { type: "string", description: "Exakt text som ska ersättas" },
        new_str: { type: "string", description: "Ny text. Tom sträng raderar." },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "list_files",
    description:
      "Lista filer och mappar. Använd detta FÖRST för att orientera dig i ett " +
      "projekt du inte känner till — gissa aldrig filnamn. Sökvägarna som " +
      "returneras kan användas direkt med read_file och edit_file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Mapp att lista. Utelämna för projektroten.",
        },
        max_depth: {
          type: "number",
          description: "Antal nivåer djupt. Standard 3.",
        },
      },
      required: [],
    },
  },
  {
    name: "run_command",
    description: "Kör ett shell-kommando i projektroten.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "search_files",
    description:
      "Sök efter en textsträng i filer under projektroten. Använd detta för " +
      "att hitta VAR något är definierat eller används (funktioner, " +
      "variabler, konfiguration, importer) — läs inte filer på måfå för att " +
      "leta efter det. Returnerar träffar som fil:radnummer:radinnehåll.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Textsträng att söka efter." },
        path: {
          type: "string",
          description: "Mapp att söka i. Utelämna för projektroten.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Skiftlägeskänslig sökning. Standard false.",
        },
      },
      required: ["query"],
    },
  },
];

export type ConfirmFn = (command: string) => Promise<boolean>;

export async function executeTool(
  name: string,
  input: any,
  workdir: string,
  confirm?: ConfirmFn
): Promise<string> {
  try {
    switch (name) {
        case "read_file": {
            if (SECRET_FILE_PATTERN.test(String(input.path))) {
              return "NEKAT: filen kan innehålla hemligheter och läses inte";
            }
            const full = safePath(workdir, input.path);
            const text = await readFile(full, "utf-8");
            readFiles.add(full);
            return truncateFileContent(text);
          }

          case "write_file": {
            const full = safePath(workdir, input.path);
    
            const exists = await readFile(full, "utf-8").then(
              () => true,
              () => false
            );
            if (exists) {
              return (
                `FEL: ${input.path} finns redan. write_file är bara för nya filer. ` +
                `Läs filen med read_file och använd sedan edit_file för att ändra den.`
              );
            }
    
            await mkdir(dirname(full), { recursive: true });
        await writeFile(full, input.content, "utf-8");
        return `Skrev ${input.path} (${input.content.length} tecken)`;
      }

      case "edit_file": {
        const full = safePath(workdir, input.path);
        const original = await readFile(full, "utf-8");

        const count = original.split(input.old_str).length - 1;
        if (count === 0) {
          return (
            `FEL: old_str hittades inte i ${input.path}. ` +
            `Läs filen igen — texten måste matcha exakt, inklusive indrag och radbrytningar.`
          );
        }
        if (count > 1) {
          return (
            `FEL: old_str hittades ${count} gånger i ${input.path}. ` +
            `Ta med fler omgivande rader så att den blir unik.`
          );
        }

        const updated = original.replace(input.old_str, input.new_str);
        await writeFile(full, updated, "utf-8");

        const before = original.split("\n").length;
        const after = updated.split("\n").length;
        return `Ändrade ${input.path} (${before} → ${after} rader)`;
      }
      case "list_files": {
        const root = resolve(workdir);
        const start = safePath(workdir, input.path ?? ".");
        const maxDepth = Math.min(input.max_depth ?? 3, 8);
        const cap = 500;
        const out: string[] = [];
        await walk(start, root, 1, maxDepth, out, cap);
        if (out.length === 0) return "(tom mapp)";
        const note =
          out.length >= cap
            ? `\n(avkortad vid ${cap} poster — lista en undermapp för mer)`
            : "";
        return out.join("\n") + note;
      }

      case "run_command": {
        if (confirm) {
          const ok = await confirm(input.command);
          if (!ok) {
            return "AVBRUTET: användaren nekade kommandot. Kör det inte igen. Fråga vad som ska göras i stället.";
          }
        }
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: workdir,
          timeout: 60_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const combined = stdout + stderr;
        return combined ? truncateCommandOutput(combined) : "(ingen output)";
      }

      case "search_files": {
        const root = resolve(workdir);
        const start = safePath(workdir, input.path ?? ".");
        const caseSensitive = !!input.case_sensitive;
        const cap = 100;

        const entries: string[] = [];
        await walk(start, root, 1, 8, entries, 2000);

        const query = String(input.query);
        const needle = caseSensitive ? query : query.toLowerCase();
        const hits: string[] = [];
        let truncated = false;

        outer: for (const rel of entries) {
          if (rel.endsWith("/")) continue;
          const full = resolve(root, rel);
          let content: string;
          try {
            content = await readFile(full, "utf-8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const haystack = caseSensitive ? line : line.toLowerCase();
            if (haystack.includes(needle)) {
              hits.push(`${rel}:${i + 1}:${line}`);
              if (hits.length >= cap) {
                truncated = true;
                break outer;
              }
            }
          }
        }

        if (hits.length === 0) return `(inga träffar för "${input.query}")`;
        const note = truncated
          ? `\n[avkortad: visade de första ${cap} träffarna — sök i en snävare undermapp för fler.]`
          : "";
        return hits.join("\n") + note;
      }

      default:
        return `Okänt verktyg: ${name}`;
    }
  } catch (err: any) {
    return `FEL: ${err.message}`;
  }
}