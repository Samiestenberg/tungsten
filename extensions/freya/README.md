# Freya

Tungsten's built-in AI. Two local models, no account, no telemetry, no network.

## The division of labour

Freya has **two lanes**, and that is the whole design. Both ship inside the app.

| | Completion lane | Instruct lane |
| --- | --- | --- |
| Model | Qwen2.5-Coder-**1.5B base** | Qwen2.5-Coder-**3B instruct** |
| Port | `127.0.0.1:11435` | `127.0.0.1:11436` |
| Lifetime | loaded at startup, stays warm | loads on first use, released after 5 min idle |
| What | inline completion, whole blocks, return values, type signatures, next-edit prediction, ghost-text syntax fix, commit messages | explain, rewrite a selection, fix a semantic error, generate tests, refactor presets, name things, second opinion, the chat |
| Frequency | every keystroke | when you ask |
| Setting | `freya.light.backend` (default `embedded`) | `freya.instruct.enabled` (default `true`) |

The line between them is not size. It is this question:

> Do I have to write an **instruction**, or is the model just continuing what is
> already there?

Continuation → 1.5B. Instruction → 3B. The line is never blurred to save a
model: a base model cannot follow an instruction, and an instruct model is worse
at fill-in-the-middle.

### Why two processes

`llama-server` takes the model as an argument, so the two lanes are two child
processes of the same binary on two ports. Sharing a port would mean an
`/infill` request occasionally landing in the instruct model — which produces
nonsense, not an error.

The 3B is on-demand because of memory: 940 MB + 2.0 GB resident at the same time
leaves no room for the editor on an 8 GB machine.

Licences: llama.cpp MIT, Qwen2.5-Coder-1.5B Apache-2.0, Qwen2.5-Coder-3B-Instruct
**Qwen Research License** (not Apache-2.0 — see
`freya-runtime/THIRD-PARTY-NOTICES.txt`, and `build/freya/fetchLocalRuntime.ts`
for the one constant to change for a commercial build).

### The optional Ollama path

Only for completion, and only if you want a different small model:

```
ollama pull qwen2.5-coder:1.5b-base   # only if you set light.backend=ollama
```

It must be a **base** model. An instruct model cannot do FIM and answers with
prose instead of code. The instruct lane is always the embedded 3B — there is no
Ollama path for it, because "no installation" is the point.

## Two-step debugging

Errors are split by what kind of error they are, and the split is the reason it
feels fast:

| | Syntax error (missing `}`, `,`, `;`) | Semantic error (types, logic) |
| --- | --- | --- |
| Model | 1.5B, fill-in-the-middle | 3B instruct |
| When | while you type | when you click the error |
| Shown as | faint ghost text, Tab to accept | a diff to approve |
| Measured | 171-230 ms | ~6 s |

The parser already knows exactly what is missing in the first case, so there is
nothing to reason about. The second case needs someone to understand the types
and what the last change was trying to do — so the recent `git diff` is sent
along with the file.

The boundary lives in one place (`src/fim/syntaxSignal.ts`) and both sides ask
the same function, so it cannot drift apart.

## Nothing is applied without you

Every surface that changes code shows a diff first (`src/preview.ts` is the only
route from "the model suggested something" to "the file changed"). Applying also
re-checks that the text has not changed since the diff was opened.

| Surface | Keybinding |
| --- | --- |
| Rewrite selection with an instruction | `Ctrl+K Ctrl+I` |
| Refactor presets | `Ctrl+K Ctrl+R` |
| Fix a semantic error | lightbulb on the error |
| Accept the ghost-text syntax fix | `Tab` (only while it is visible) |

`Ctrl+K Ctrl+I` rather than a bare `Ctrl+K`: `Ctrl+K` is the prefix for VS Code's
whole chord family, and taking it would remove all of them.

## The chat

A **guide to the editor**, on the local 3B. It answers questions about settings,
keybinds and features, and small coding questions. It cannot read files, write
files or run commands, and it has no tools.

That is deliberate. A 3B positioned as an autonomous coding agent promises more
than it can keep and pulls you to the wrong surface; real changes belong where
the selection, the error and the diff already are.

## Commit messages

**Freya: Write commit message** (the sparkle button in Source Control) reads
`git diff --staged`, drafts a message on the 1.5B (few-shot) and falls back to
the 3B if the 1.5B is missing. Both are local. You edit and commit yourself —
Freya never commits.

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
`.dev.vars` and `.pem` are not warned about: that is where secrets *belong*
(`SECRET_FILE_PATTERN` in `src/secretFiles.ts`). They are scanned in a commit,
because that is where they do damage.

Note: VS Code's git extension has no pre-commit hook for extensions, so Freya
cannot block the Commit button itself. It stops the flows it owns.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `freya.light.backend` | `embedded` | Completion lane: `embedded` or your own `ollama`. |
| `freya.local.enabled` | `true` | Use the embedded 1.5B at all. |
| `freya.local.port` | `11435` | Port for the completion server. Never 11434. |
| `freya.local.contextSize` | `4096` | Context window for the 1.5B. |
| `freya.instruct.enabled` | `true` | Use the embedded 3B at all. |
| `freya.instruct.port` | `11436` | Port for the instruct server. Never 11434 or 11435. |
| `freya.instruct.contextSize` | `8192` | Context window for the 3B. |
| `freya.instruct.idleUnloadMs` | `300000` | Release the 3B after this much quiet. `0` keeps it loaded. |
| `freya.autocomplete.enabled` | `true` | Inline completion on/off. |
| `freya.autocomplete.model` | `qwen2.5-coder:1.5b-base` | FIM model, Ollama path only. |
| `freya.nextEdit.enabled` | `true` | Predict where the next change goes. |
| `freya.syntaxFix.enabled` | `true` | Ghost-text guess at a missing `}` or `,`. |
| `freya.tentative.enabled` | `true` | Guessy completions in catch blocks, regexes and test files. |
| `freya.ollama.url` | `http://localhost:11434` | Only used when `light.backend` is `ollama`. |
| `freya.secrets.enabled` | `true` | Secret warnings on/off. |

## Privacy

The default build makes **no outbound network requests** for AI. Both models run
as child processes on `127.0.0.1`, and nothing else is contacted.

This is verified, not asserted: `src/test/privacy.test.ts` walks the real import
graph from `extension.ts` and fails the build if any reachable module mentions
`CLOUDFLARE_` credentials, contains a URL to anything but `127.0.0.1`/`localhost`,
or reaches the dormant cloud code.

A cloud tier exists in `src/cloud.ts` but is **off**, behind a hard-coded
constant that no setting can flip, and it is not imported by anything active. It
never reads any credential while that constant is false. The agent loop it
belonged to is likewise dormant in `src/participant.ts`.

## Untrusted folders

The extension declares `untrustedWorkspaces.supported: "limited"`, so it
activates and both lanes work in a folder you have not trusted. They only read
what you selected and talk to a process we started on `127.0.0.1` — there is
nothing to leak, and the earlier agent that could write files and run commands is
retired.

What a hostile workspace must not be able to do is redirect **where** text goes
or **which** binary we start. Those settings are locked from workspace scope:

```
freya.local.runtimePath   freya.local.port
freya.instruct.runtimePath  freya.instruct.port
freya.ollama.url
```

`src/test/restrictedConfigurations.test.ts` fails if a new `.port`,
`.runtimePath` or `.url` setting is added without being locked.
