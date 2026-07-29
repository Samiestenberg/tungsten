## Two models, two jobs

Tungsten ships with both. Neither needs installing, neither needs an account,
and neither sends anything off this machine.

| Model | What it does | When it runs |
| --- | --- | --- |
| Qwen2.5-Coder-1.5B (base) | Completion, block completion, return values and types, next-edit prediction, the ghost-text syntax fix, commit messages | Always loaded, `127.0.0.1:11435` |
| Qwen2.5-Coder-3B-Instruct | Explain, rewrite a selection, fix a semantic error, generate tests, refactor presets, name things, second opinion, the chat | Loads on first use, `127.0.0.1:11436`, released after 5 minutes idle |

The split is not about size. It is about the question:

> Do I have to write an **instruction**, or is the model just continuing what is
> already there?

Continuing is the 1.5B's job — it is fast, it runs on every keystroke, and it
never has to work out what you meant. Following an instruction is the 3B's job —
it runs when you ask for it, and only then.

The 3B loads on demand and is released when idle so the two models are never
forced to sit in memory at the same time on an 8 GB machine.

Turn the instruct lane off entirely with `freya.instruct.enabled` if you only
want completion.
