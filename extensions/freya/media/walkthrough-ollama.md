## Ollama

Freya kör sina modeller lokalt. Ingenting lämnar maskinen i standardläget.

1. Hämta Ollama: https://ollama.com/download
2. Starta den:

```
ollama serve
```

Freya letar på `http://localhost:11434`. Kör du Ollama på en annan port eller
maskin: sätt `freya.ollama.url`.

Statusraden nere till höger säger till när Ollama inte svarar. Den är tyst när
allt fungerar.
