## Everything already runs locally

Freya has **two embedded models** inside the app, both served by
llama.cpp-server (MIT), which Tungsten starts itself on `127.0.0.1`.

The small one — Qwen2.5-Coder-1.5B (Apache-2.0), port 11435 — answers while you
type:

- inline completion, and whole blocks after you open a body
- return values and type signatures
- next-edit prediction: where the next change goes
- the faint ghost-text guess when the parser sees a missing `}` or `,`
- commit messages

Measured: ~200-450 ms for a line or a gap, ~2 s for a whole function body.

The larger one — IBM Granite-3B-Code-Instruct (Apache-2.0), port 11436 — answers when you ask:
explain, rewrite a selection, fix an error, generate tests, refactor, name
things, and the chat. It loads on first use and releases its memory after five
minutes of quiet, so the two never sit in RAM at once.

No installation, no sign-in, no network traffic. The status bar at the bottom
right tells you which models are answering.

If you would rather run your own small model for completion, set
`freya.light.backend` to `ollama`. The instruct lane stays embedded either way.
