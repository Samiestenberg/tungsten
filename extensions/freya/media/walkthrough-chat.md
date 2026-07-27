## Chatten

Freya är default-deltagaren i chattpanelen — du behöver inte skriva `@freya`.

- `Ctrl+Alt+I` öppnar chatten.
- Agenten har sex verktyg: läsa, skriva och redigera filer, lista och söka i
  arbetsytan, och köra kommandon. Kommandon kräver alltid en bekräftelse först.
- Freya använder aldrig `vscode.lm.tools`, så workbenchens automationsverktyg
  ligger utanför modellens räckvidd.

Vill du köra i molnet i stället: sätt `freya.chat.backend` till `workersai` och
kör **Freya: Ange Cloudflare-nycklar**. Autocomplete stannar lokal oavsett.
