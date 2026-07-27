## Everything light already runs locally

Freya has an **embedded model** inside the app: Qwen2.5-Coder-1.5B (Apache-2.0),
served by llama.cpp-server (MIT) which Tungsten starts itself on
`127.0.0.1:11435`.

It powers:

- inline autocomplete (fill-in-the-middle)
- commit messages
- **Freya: Explain selected code**

No installation, no sign-in, no network traffic. Measured completion latency:
~270 ms on average, 8 out of 8 under 600 ms.

The status bar at the bottom right tells you which model is answering. If you
would rather use your own Ollama for the light work, set `freya.light.backend`
to `ollama`.
