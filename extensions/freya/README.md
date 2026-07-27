# Freya

Tungstens inbyggda kodagent. Local-first, BYOK, ingen telemetri.

## Vad du behöver

Freya kör mot en **lokal Ollama**. Det är default och det som är verifierat.

```
ollama serve
ollama pull qwen2.5-coder:14b
ollama pull qwen2.5-coder:1.5b-base
```

| Modell | Yta | Krav |
| --- | --- | --- |
| `qwen2.5-coder:14b` | chatt / agent | Behöver klara verktygsanrop. |
| `qwen2.5-coder:1.5b-base` | inline-autocomplete | Måste vara en **base**-modell. En instruct-modell klarar inte FIM och svarar med prosa i stället för kod. |

Om Ollama inte svarar, eller om en modell saknas, säger Freya det:

- **i chattpanelen** — en rad med exakt vilket `ollama pull` som behövs, i
  stället för tystnad,
- **i statusraden** nere till höger, som bara syns när något är fel,
- via kommandot **Freya: Kolla att Ollama och modellerna finns**.

Freya installerar aldrig Ollama eller några modeller åt dig.

## Commit-meddelanden

**Freya: Skriv commit-meddelande** (sparkle-knappen i källkontroll-vyn) läser
`git diff --staged`, skriver ett förslag med den lokala modellen och lägger det
i commit-fältet. Du redigerar och committar själv — Freya committar aldrig.

## Hemligheter

Skanningen körs helt lokalt: mönstermatchning, ingen modell, inga
nätverksanrop. Den flaggar privata nyckelblock, AWS-nycklar, GitHub-, Slack-,
OpenAI-, Anthropic- och Google-tokens, JWT:er samt hemligheter i tilldelningar
och miljövariabler. Platshållare (`process.env.X`, `<din-nyckel>`,
`changeme`, `xxxx`) flaggas inte.

- **Vid inklistring:** en modal varning med möjlighet att ångra, innan texten
  hinner sparas.
- **Löpande:** träffar syns i Problem-panelen.
- **Före commit:** commit-generatorn skannar de stagade ändringarna och stoppar
  om något ser ut som en hemlighet. Kommandot **Freya: Skanna stagade
  ändringar för hemligheter** gör samma sak när du vill.

Bara tillagda rader skannas — en borttagen hemlighet är en bra sak. `.env`,
`.dev.vars` och `.pem` varnas det inte i: det är där hemligheter *ska* ligga
(samma `SECRET_FILE_PATTERN` som `read_file` använder). De skannas däremot i en
commit, eftersom det är där de gör skada.

Notera: VS Codes git-extension har ingen pre-commit-hook för extensions, så
Freya kan inte hindra själva Commit-knappen. Den stoppar de flöden den äger.

## Inställningar

| Inställning | Default | Vad den gör |
| --- | --- | --- |
| `freya.chat.backend` | `ollama` | `ollama` (lokalt) eller `workersai` (moln, BYOK). |
| `freya.ollama.url` | `http://localhost:11434` | Används av både chatt och autocomplete. |
| `freya.chat.ollamaModel` | `qwen2.5-coder:14b` | Chattmodell i Ollama. |
| `freya.autocomplete.model` | `qwen2.5-coder:1.5b-base` | FIM-modell. |
| `freya.autocomplete.enabled` | `true` | Inline-komplettering av/på. |
| `freya.chat.maxSteps` | `25` | Högsta antal verktygssteg per fråga. |
| `freya.commit.model` | tom = `chat.ollamaModel` | Modell för commit-meddelanden. Måste vara en instruct-modell. |
| `freya.secrets.enabled` | `true` | Hemlighets-varningar av/på. |

## Molnläget (valfritt)

`freya.chat.backend` = `workersai` kör chatten mot Cloudflare Workers AI med
dina egna nycklar. Kör **Freya: Ange Cloudflare-nycklar** — de sparas i
OS-nyckelringen via SecretStorage, aldrig i `settings.json` och aldrig i repot.
Autocomplete stannar lokal även då.

Nycklar läses i ordningen SecretStorage → `.env` i arbetsytan → miljövariabler
(`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).

## Verktyg

Agenten har sex verktyg: `read_file`, `write_file`, `edit_file`, `list_files`,
`search_files` och `run_command`. `run_command` kräver alltid en bekräftelse
innan något körs.

Freya går direkt mot sin egen modellprovider och använder aldrig `vscode.lm`
eller `vscode.lm.tools`. Workbenchens automationsverktyg (MCP-servrar,
`type_in_page` m.fl.) finns därför inte i modellens verktygslista alls — det är
en egenskap av konstruktionen, inte ett filter.

`read_file` vägrar läsa `.env`, `.dev.vars` och `.pem` (`SECRET_FILE_PATTERN` i
`src/core/tools.ts`).

## Obetrodda mappar

Freya är avstängd i obetrodda mappar (`untrustedWorkspaces.supported: false`) —
den läser och skriver filer och kan köra kommandon, så det är rätt default.

I restricted mode aktiverar VS Code inte extensionen alls, så Freya kan inte
säga något själv. Chattpanelen visar därför raden **"Freya är pausad i en
obetrodd mapp"** med en **Lita på mappen**-knapp. Den kommer från workbenchen
(`src/vs/workbench/contrib/chat/browser/viewsWelcome/tungstenRestrictedModeWelcome.ts`),
inte från den här extensionen.
