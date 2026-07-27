## Heavier work

Agent work across several files, large refactorings and deep reasoning want a
model bigger than 1.5B. Freya does **not** require you to run a large model
locally — the heavy lane is cloud by default.

| Option | What it needs |
| --- | --- |
| Cloudflare Workers AI | Your own keys. Run **Freya: Set Cloudflare keys** — they are stored in the OS keychain. |
| Your own Ollama | `ollama pull qwen2.5-coder:14b`. An optional extra for those with the hardware. |

`freya.chat.backend` is `auto`: cloud when keys exist, otherwise your Ollama.

The light lane is unaffected by this choice — it stays on the embedded model and
works even without both keys and Ollama.
