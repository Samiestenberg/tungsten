## The chat

Freya is the default participant in the chat panel — you do not need to type
`@freya`.

- `Ctrl+Alt+I` opens the chat.
- The agent has six tools: read, write and edit files, list and search the
  workspace, and run commands. Commands always require confirmation first.
- Freya never uses `vscode.lm.tools`, so the workbench automation tools are out
  of the model's reach.

To run in the cloud instead, set `freya.chat.backend` to `workersai` and run
**Freya: Set Cloudflare keys**. Autocomplete stays local either way.
