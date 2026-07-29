## The chat

Freya is the default participant in the chat panel — you do not need to type
`@freya`. `Ctrl+Alt+I` opens it.

It is a **guide to the editor**, running on the embedded 3B model. Ask it about
settings, keybinds, what a feature does, or a small coding question.

It does not read your files, it does not write files, and it does not run
commands. That is deliberate: real code changes belong on the surfaces that
already have your selection, the error message and a diff to approve.

| You want to | Use |
| --- | --- |
| Change the selected code | `Ctrl+K Ctrl+I` — rewrite with an instruction |
| Apply a common refactoring | `Ctrl+K Ctrl+R` — refactor presets |
| Fix an error | Click the lightbulb on it and pick the Freya fix |
| Understand some code | **Freya: Explain selected code** |
| Get tests | **Freya: Generate tests for this code** |

Every one of them shows you a diff or a preview before anything in your file
changes.
