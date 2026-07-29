# Tungsten

Tungsten is a fork of [Visual Studio Code](https://github.com/microsoft/vscode) with a
coding agent, **Freya**, built into the editor instead of bolted on as an extension.

The point of the fork is where the models run. Tungsten ships **two** local models in
the box: a `llama.cpp` server plus a 1.5B and a 3B GGUF, both bound to `127.0.0.1`
and started by the app itself. Everything — completions, explanations, rewrites,
fixes, tests, the chat — runs on those. Nothing is sent anywhere.

## The two lanes

Tungsten splits AI work in two. Not by size, but by the question being asked:

> Do I have to write an **instruction**, or is the model just continuing what is
> already there?

| | Completion lane | Instruct lane |
|---|---|---|
| Question | "what comes next here?" | "do this to this code" |
| Model | Qwen2.5-Coder-1.5B base (bundled) | Qwen2.5-Coder-3B instruct (bundled) |
| Where | `127.0.0.1:11435` | `127.0.0.1:11436` |
| What | Inline completion, whole blocks, return values and types, next-edit prediction, ghost-text syntax fix, commit messages | Explain, rewrite a selection, fix a semantic error, generate tests, refactor, name things, second opinion, the chat |
| Lifetime | Loaded at startup, stays warm | Loads on first use, released after 5 min idle |
| Cost | Free, offline, every keystroke | Free, offline, when you ask |

Both need no installation, no account and no network. The 3B is loaded on demand so
the two are never forced to sit in memory at once on an 8 GB machine.

There is **no agent loop and no tool calling** anywhere in either lane. Each function
is one shot: text in, text out. Our code holds the control flow; the model only fills
a slot. That removes an entire class of failure — models writing tool calls as prose
JSON that never execute — by construction rather than by parsing.

## What we can honestly say about privacy

These are measured claims, not marketing. Each one was verified against the packaged
build before it was written down:

- **Your code does not leave the machine.** Both embedded models listen on
  `127.0.0.1` and nowhere else, behind a derived API key. Verified: `/props` returns
  401 without it.
- **The default build makes no outbound AI requests at all.** There is no cloud tier
  to turn on: the Cloudflare code is dormant behind a hard-coded constant that no
  setting can flip, and it is not reachable from the running code. A test
  (`extensions/freya/src/test/privacy.test.ts`) walks the real import graph and fails
  if any reachable module so much as mentions `CLOUDFLARE_`, or contains a URL to
  anything but `127.0.0.1`/`localhost`.
- **No telemetry, no crash reports sent, no update checks, no marketplace pings.**
  `product.json` carries none of `enableTelemetry`, `aiConfig`, `updateUrl`,
  `appCenter` or `extensionsGallery`, and the crash reporter runs with
  `uploadToServer: false`.

What we do **not** claim:

- The app is not silent on the network in an absolute sense: Chromium's own resolver
  may use DNS-over-HTTPS, which is the browser engine, not Tungsten.
- `freya.ollama.url` is yours to configure. Point it at a remote host, set
  `freya.light.backend` to `ollama`, and code will go there — by your choice.

## Workspace trust

Opening an untrusted folder does not turn Freya off. Both lanes keep working: they
read only what you selected and talk only to a process we started ourselves. The old
agent — which wrote files and ran commands — is retired, so the thing workspace trust
existed to gate is gone.

What a hostile workspace still must not do is redirect **which** binary is launched or
**where** text is sent. Those settings are ignored from workspace scope until you
trust the folder:

```
freya.local.runtimePath      freya.local.port
freya.instruct.runtimePath   freya.instruct.port
freya.ollama.url
```

A test fails the build if a new `.port`, `.runtimePath` or `.url` setting is added
without being locked.

## Building

Tungsten builds like VS Code. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
prerequisites.

```sh
npm install
npm run compile
```

The embedded runtime is not in git — about three gigabytes of weights and binaries
does not belong in history. Fetch it separately:

```sh
node --experimental-strip-types build/freya/fetchLocalRuntime.ts
```

It pulls a pinned `llama.cpp` release from GitHub with a checked SHA-256, then both
GGUFs — preferring a copy you already have via Ollama over downloading another one,
and verifying size and SHA-256 on what it downloads. `FREYA_SKIP_INSTRUCT=1` skips
the 3B if you are only working on the completion lane.

To build the Windows installer from a packaged build:

```sh
npx gulp vscode-win32-x64-user-setup
```

## "Unknown publisher"

Tungsten is not code-signed, so Windows SmartScreen will say the publisher is unknown.
That is not a sign that anything is wrong. We chose not to buy a Windows code-signing
certificate — several thousand kronor a year — and put that into the product instead.
The installer says the same thing to your face before it installs anything, and points
here so you can check the source yourself.

## Licence

Tungsten is MIT licensed, and so is the Visual Studio Code source it is built from.
The upstream copyright is Microsoft's and stays intact in [LICENSE.txt](LICENSE.txt);
Tungsten's own changes are added under the same terms. Third-party components are
listed in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).

The bundled models and runtime carry their own licences:

| Component | Licence |
|---|---|
| llama.cpp | MIT |
| Qwen2.5-Coder-1.5B (base) | Apache-2.0 |
| Qwen2.5-Coder-3B-Instruct | Qwen Research License |

Note the third row. Qwen2.5-Coder is Apache-2.0 in every size **except** 3B, which
falls under the Qwen Research License: redistribution for research and evaluation is
allowed, commercial use is not. A commercial build must swap that model. The swap is
a single constant (`INSTRUCT_MODEL` in `build/freya/fetchLocalRuntime.ts`); the
closest Apache-2.0 alternative in the same size class is
`granite-3b-code-instruct-128k`.

Tungsten is not affiliated with, endorsed by, or supported by Microsoft.
