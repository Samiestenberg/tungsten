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
    throw new Error(`Path outside the workdir: ${p}`);
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
    `Use run_command with findstr/select-string to search the rest.]`
  );
}

function truncateCommandOutput(text: string): string {
  if (text.length <= RUN_COMMAND_MAX_CHARS) return text;
  const shown = text.slice(0, RUN_COMMAND_MAX_CHARS);
  return (
    shown +
    `\n\n[avkortad: visade ${RUN_COMMAND_MAX_CHARS} av ${text.length} tecken. ` +
    `Use findstr/select-string in the command to search the rest.]`
  );
}

export const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a file relative to the project root.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a file. Creates folders as needed. Overwrites an existing file.",
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
      "Change part of a file. old_str must occur EXACTLY once in the file -- " +
      "include enough surrounding lines to make it unique. " +
      "Read the file first. Use this instead of write_file on existing files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        old_str: { type: "string", description: "Exact text to replace" },
        new_str: { type: "string", description: "New text. An empty string deletes." },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and folders. Use this FIRST to orient yourself in a " +
      "project you do not know -- never guess file names. The returned paths " +
      "can be used directly with read_file and edit_file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Folder to list. Omit for the project root.",
        },
        max_depth: {
          type: "number",
          description: "How many levels deep. Default 3.",
        },
      },
      required: [],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the project root.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "search_files",
    description:
      "Search for a text string in files under the project root. Use this to " +
      "find WHERE something is defined or used (functions, " +
      "variables, configuration, imports) -- do not read files at random to " +
      "look for it. Returns hits as file:line:content.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Text string to search for." },
        path: {
          type: "string",
          description: "Folder to search in. Omit for the project root.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Case-sensitive search. Default false.",
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
              return "DENIED: this file may contain secrets and is not read";
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
                `ERROR: ${input.path} already exists. write_file is only for new files. ` +
                `Read it with read_file and then use edit_file to change it.`
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
            `Read the file again -- the text must match exactly, including indentation and line breaks.`
          );
        }
        if (count > 1) {
          return (
            `ERROR: old_str was found ${count} times in ${input.path}. ` +
            `Include more surrounding lines so it becomes unique.`
          );
        }

        const updated = original.replace(input.old_str, input.new_str);
        await writeFile(full, updated, "utf-8");

        const before = original.split("\n").length;
        const after = updated.split("\n").length;
        return `Changed ${input.path} (${before} -> ${after} lines)`;
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
            ? `\n(truncated at ${cap} entries -- list a subfolder for more)`
            : "";
        return out.join("\n") + note;
      }

      case "run_command": {
        if (confirm) {
          const ok = await confirm(input.command);
          if (!ok) {
            return "ABORTED: the user denied the command. Do not run it again. Ask what to do instead.";
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

        if (hits.length === 0) return `(no matches for "${input.query}")`;
        const note = truncated
          ? `\n[truncated: showed the first ${cap} matches -- search a narrower subfolder for more.]`
          : "";
        return hits.join("\n") + note;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `FEL: ${err.message}`;
  }
}