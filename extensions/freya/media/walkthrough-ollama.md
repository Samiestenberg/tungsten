## Allt lätt kör redan lokalt

Freya har en **inbäddad modell** i appen: Qwen2.5-Coder-1.5B (Apache-2.0), körd
av llama.cpp-server (MIT) som Tungsten startar själv på `127.0.0.1:11435`.

Den driver:

- inline-autocomplete (fill-in-the-middle)
- commit-meddelanden
- **Freya: Förklara markerad kod**

Ingen installation, ingen inloggning, ingen nätverkstrafik. Uppmätt
komplettering: ~270 ms i snitt, 8 av 8 under 600 ms.

Statusraden nere till höger säger vilken modell som svarar. Vill du hellre
använda din egen Ollama för det lätta: sätt `freya.light.backend` till
`ollama`.
