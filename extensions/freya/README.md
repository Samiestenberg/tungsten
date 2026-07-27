# Freya

Tungsten's built-in coding agent. Local-first, BYOK, no telemetry.

## The division of labour

Freya has **two lanes**, and that is the whole design:

| | Light lane | Heavy lane |
| --- | --- | --- |
| What | autocomplete, commit messages, code explanations | agent across several files, large refactorings, deep reasoning |
| Model | **embedded** Qwen2.5-Coder-1.5B, served by llama.cpp inside the app | Cloudflare Workers AI (qwen3) or your own Ollama |
| Requires | nothing — ships with the app | your own keys, or a large model you pulled yourself |
| Cost | zero, offline | cloud, or your own hardware |
| Setting | `freya.light.backend` (default `embedded`) | `freya.chat.backend` (default `auto`) |

This means the app **works straight out of the download**: with no Ollama and no
cloud keys you still get autocomplete, commit messages and explanations.
A large local model is an **option**, never a requirement.

`freya.chat.backend: auto` picks cloud when Cloudflare keys exist and your local
Ollama otherwise. The status bar at the bottom right shows which model answers in
each lane.

### The embedded model

Started as a child process on `127.0.0.1:11435` (never 11434 — that one belongs
to Ollama) and shut down when Tungsten exits. Measured: ~270 ms per completion,
8 out of 8 under 600 ms.

Licences: llama.cpp MIT, Qwen2.5-Coder-1.5B Apache-2.0. See
`freya-runtime/THIRD-PARTY-NOTICES.txt` in the app's resources.

### The optional Ollama path

```
ollama pull qwen2.5-coder:14b        # heavy lane, optional
ollama pull qwen2.5-coder:1.5b-base  # only if you set light.backend=ollama
```

| Model | Surface | Requirement |
| --- | --- | --- |
| `qwen2.5-coder:14b` | chat / agent | Needs to handle tool calls. |
| `qwen2.5-coder:1.5b-base` | inline autocomplete | Must be a **base** model. An instruct model cannot do FIM and answers with prose instead of code. |

When Ollama is needed but does not answer, Freya says so in the chat panel with
the exact `ollama pull` required, in the status bar, and via **Freya: Check that
Ollama and the models are present**. Freya never installs Ollama or any model
for you.

## Commit messages

**Freya: Write commit message** (the sparkle button in the Source Control view)
reads `git diff --staged`, drafts a message with the local model and puts it in
the commit box. You edit and commit yourself — Freya never commits.

## Secrets

The scan runs entirely locally: pattern matching, no model, no network calls. It
flags private key blocks, AWS keys, GitHub, Slack, OpenAI, Anthropic and Google
tokens, JWTs, and secrets in assignments and environment variables. Placeholders
(`process.env.X`, `<your-key>`, `changeme`, `xxxx`) are not flagged.

- **On paste:** a modal warning with the option to undo, before the text is saved.
- **Continuously:** hits appear in the Problems panel.
- **Before commit:** the commit generator scans the staged changes and stops if
  something looks like a secret. The command **Freya: Scan staged changes for
  secrets** does the same on demand.

Only added lines are scanned — a removed secret is a good thing. `.env`,
`.dev.vars` and `.pem` are not warned about: that is where secrets *belong* (the
same `SECRET_FILE_PATTERN` that `read_file` uses). They are scanned in a commit,
because that is where they do damage.

Note: VS Code's git extension has no pre-commit hook for extensions, so Freya
cannot block the Commit button itself. It stops the flows it owns.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `freya.chat.backend` | `auto` | HEAVY lane: `auto` (cloud if keys, otherwise Ollama), `workersai` or `ollama`. |
| `freya.light.backend` | `embedded` | LIGHT lane: `embedded` (embedded 1.5B) or `ollama`. |
| `freya.local.enabled` | `true` | Use the embedded model at all. |
| `freya.local.port` | `11435` | Port for the embedded server. Never 11434. |
| `freya.ollama.url` | `http://localhost:11434` | Used by both chat and autocomplete. |
| `freya.chat.ollamaModel` | `qwen2.5-coder:14b` | Chat model in Ollama. |
| `freya.autocomplete.model` | `qwen2.5-coder:1.5b-base` | FIM model. |
| `freya.autocomplete.enabled` | `true` | Inline completion on/off. |
| `freya.chat.maxSteps` | `25` | Maximum tool steps per question. |
| `freya.commit.model` | empty = `chat.ollamaModel` | Model for commit messages. Must be an instruct model. |
| `freya.secrets.enabled` | `true` | Secret warnings on/off. |

## Cloud mode (optional)

`freya.chat.backend` = `workersai` runs the chat against Cloudflare Workers AI
with your own keys. Run **Freya: Set Cloudflare keys** — they are stored in the
OS keychain via SecretStorage, never in `settings.json` and never in the repo.
Autocomplete stays local even then.

Keys are read in this order: SecretStorage → `.env` in the workspace →
environment variables (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).

## Tools

The agent has six tools: `read_file`, `write_file`, `edit_file`, `list_files`,
`search_files` and `run_command`. `run_command` always requires confirmation
before anything runs.

Freya talks straight to its own model provider and never uses `vscode.lm` or
`vscode.lm.tools`. The workbench automation tools (MCP servers, `type_in_page`
and friends) are therefore not in the model's tool list at all — that is a
property of the construction, not a filter.

`read_file` refuses to read `.env`, `.dev.vars` and `.pem`
(`SECRET_FILE_PATTERN` in `src/core/tools.ts`).

## Untrusted folders

Freya is disabled in untrusted folders (`untrustedWorkspaces.supported: false`) —
it reads and writes files and can run commands, so that is the right default.

In restricted mode VS Code does not activate the extension at all, so Freya
cannot say anything itself. The chat panel therefore shows the row **"Freya is
paused in an untrusted folder"** with a **Trust the folder** button. That comes
from the workbench
(`src/vs/workbench/contrib/chat/browser/viewsWelcome/tungstenRestrictedModeWelcome.ts`),
not from this extension.
