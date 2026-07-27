## Tyngre arbete

Agent-arbete över flera filer, stora refaktoreringar och djupt resonemang vill
ha en större modell än 1.5B. Freya kräver **inte** att du kör en stor modell
lokalt — den tunga lanen är moln som standard.

| Val | Vad som behövs |
| --- | --- |
| Cloudflare Workers AI | Egna nycklar. Kör **Freya: Ange Cloudflare-nycklar** — de sparas i OS-nyckelringen. |
| Egen Ollama | `ollama pull qwen2.5-coder:14b`. Valfritt tillval för den som har hårdvaran. |

`freya.chat.backend` är `auto`: moln när nycklar finns, annars din Ollama.

Den lätta lanen påverkas inte av det här valet — den ligger kvar på den
inbäddade modellen och fungerar även utan både nycklar och Ollama.
