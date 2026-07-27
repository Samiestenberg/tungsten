# Tungsten

Tungsten is a fork of [Visual Studio Code](https://github.com/microsoft/vscode) with a
coding agent, **Freya**, built into the editor instead of bolted on as an extension.

The point of the fork is where the model runs. Tungsten ships a local model in the
box: a `llama.cpp` server and a 1.5B GGUF that start with the app, bound to
`127.0.0.1`. Everyday work — inline completions, commit messages, code explanations —
runs on that model. Nothing is sent anywhere.

## The two lanes

Tungsten splits AI work in two, because the two halves have different costs and
different privacy stories.

| | Light lane | Heavy lane |
|---|---|---|
| What | Inline completions, commit messages, explanations, secret scanning | The agent: multi-file edits, tool use, reasoning |
| Model | Embedded Qwen2.5-Coder-1.5B (bundled) | Cloudflare Workers AI, or your own Ollama |
| Where | `127.0.0.1` only | Cloud, or localhost with Ollama |
| Cost | Free, always available | Your own key, your own bill |
| Needs setup | No | Yes — you supply the key |

The light lane is the default and needs no installation, no account and no network.
The heavy lane only exists if you turn it on.

## What we can honestly say about privacy

These are measured claims, not marketing. Each one was verified against the packaged
build before it was written down:

- **In local mode your code does not leave the machine.** The embedded model listens
  on `127.0.0.1` and nowhere else, behind a derived API key.
- **The cloud is used only if you choose it, with your own key.** Without Cloudflare
  credentials no cloud provider is ever constructed.
- **No telemetry, no crash reports sent, no update checks, no marketplace pings.**
  `product.json` carries none of `enableTelemetry`, `aiConfig`, `updateUrl`,
  `appCenter` or `extensionsGallery`, and the crash reporter runs with
  `uploadToServer: false`.

What we do **not** claim:

- We make no retention promises about the cloud lane. What Cloudflare does with a
  prompt is between you and Cloudflare.
- The app is not silent on the network in an absolute sense: Chromium's own resolver
  may use DNS-over-HTTPS, which is the browser engine, not Tungsten.
- `freya.ollama.url` is yours to configure. Point it at a remote host and code will
  go there — by your choice.

## Workspace trust

Opening an untrusted folder does not turn Freya off silently. The light lane keeps
working, because it only reads and only talks to a process we started ourselves. The
agent — which writes files and can run commands — stays off until you trust the
folder, and says so with a button instead of just disappearing.

While a folder is untrusted, workspace settings cannot redirect which binary is
launched or where code is sent (`freya.local.runtimePath`, `freya.local.port` and
`freya.ollama.url` are ignored from workspace scope).

## Building

Tungsten builds like VS Code. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
prerequisites.

```sh
npm install
npm run compile
```

The embedded runtime is not in git — about a gigabyte of weights and binaries does not
belong in history. Fetch it separately:

```sh
node --experimental-strip-types build/freya/fetchLocalRuntime.ts
```

It pulls a pinned `llama.cpp` release from GitHub with a checked SHA-256, and prefers
a GGUF you already have via Ollama over downloading another copy.

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

The bundled model and runtime carry their own licences, both redistributable:

| Component | Licence |
|---|---|
| llama.cpp | MIT |
| Qwen2.5-Coder-1.5B (base) | Apache-2.0 |

Tungsten is not affiliated with, endorsed by, or supported by Microsoft.
