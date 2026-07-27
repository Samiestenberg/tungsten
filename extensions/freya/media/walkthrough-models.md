## Modellerna

Två modeller, två olika jobb:

```
ollama pull qwen2.5-coder:14b
ollama pull qwen2.5-coder:1.5b-base
```

| Modell | Används av | Varför just den |
| --- | --- | --- |
| `qwen2.5-coder:14b` | chatt och agent | Stor nog att klara verktygsanrop. |
| `qwen2.5-coder:1.5b-base` | inline-autocomplete | Liten och snabb. Måste vara en **base**-modell — en instruct-modell kan inte FIM (fill-in-the-middle) och börjar prata i stället för att komplettera. |

Vill du byta modell: `freya.chat.ollamaModel` och `freya.autocomplete.model`.
