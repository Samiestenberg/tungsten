// Guide-chattens system-prompt. REN MODUL: en sträng, inga vscode-beroenden.
//
// Egen fil av två skäl. Det första är att både chat-participanten
// (guideChat.ts) och vscode.lm-providern (languageModel.ts) svarar som samma
// guide och måste ha ORDAGRANT samma scope -- två kopior hade glidit isär.
// Det andra är att den går att testa: guidePrompt.test.ts kontrollerar att
// varje kommando och inställning som nämns nedan FAKTISKT finns i package.json.
//
// ─────────────────────────────────────────────────────────────────────────
// VARFÖR PROMPTEN SER UT SÅ HÄR. Två uppmätta fel, båda i första versionen.
//
// FEL 1 -- den hittade på produkten. Första prompten sa bara "You are
// Tungsten's built-in guide. Help with using the editor, its features,
// settings, keybinds". På frågan "how do I turn off inline completions?"
// svarade 3B:
//
//   "go to the editor settings and find the Editor: Completion section.
//    Look for the option to Show inline completions and uncheck it."
//
// Självsäkert, hjälpsamt formulerat, och helt påhittat -- den inställningen
// finns inte. En guide som inte VET produkten kommer att gissa den, för det är
// vad en språkmodell gör. Fixen är FACTS-blocket nedan: en kort, exakt lista
// på de kommandon och inställningar som finns. Efter det svarade den
// "set freya.autocomplete.enabled to false", vilket är rätt.
//
// FEL 2 -- den försökte vara agent ändå. På "go through my repo and refactor
// all the API calls to use async/await" svarade 3B med en steg-för-steg-guide
// i GO (inget i frågan nämnde Go), hittade på att Go har async/await, skrev ut
// "före" och "efter" som var identisk kod, och höll på i 33 SEKUNDER tills
// tokentaket tog slut.
//
// Instruktionen "point the user to inline edit" räckte inte, för den beskrev
// vad guiden BORDE göra utan att förbjuda det andra. Den sista regeln nedan
// förbjuder det uttryckligen -- inte bara "gör inte", utan "skriv inte ut en
// omskriven version". Efter det: 2,8 sekunder och en mening som pekar på
// Refactor selection.
//
// Kör om båda fallen innan du ändrar formuleringen.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Kommandon guiden får nämna. Testet kontrollerar att var och en finns som
 * ett registrerat kommando i package.json, så en omdöpning inte tyst gör
 * guiden till en lögnare.
 */
export const GUIDE_COMMANDS = [
	"freya.inlineEdit",
	"freya.refactor",
	"freya.explainSelection",
	"freya.generateTests",
	"freya.nameThings",
	"freya.reviewSelection",
	"freya.semanticFix",
] as const;

/** Inställningar guiden får nämna. Samma kontroll som ovan. */
export const GUIDE_SETTINGS = [
	"freya.autocomplete.enabled",
	"freya.nextEdit.enabled",
	"freya.syntaxFix.enabled",
	"freya.tentative.enabled",
	"freya.instruct.enabled",
] as const;

/**
 * ÄNDRA INTE EN RAD HÄR UTAN ATT KÖRA OM GRINDARNA. Texten nedan är ORDAGRANT
 * den som mättes mot Granite, och tätheten är inte kosmetik.
 *
 * Under bytet skrev jag först en tätare variant: samma fakta, men med längre
 * parenteser ("(ghost-text syntax fix, accepted with Tab)") och en mening till
 * om semantiska fel. Den var mer informativ och mätbart SÄMRE:
 *
 *   "What does Ctrl+K do?"
 *   -> "Ctrl+K is the command to rewrite the selection with an instruction. It
 *       is also the command to generate tests for this code. It is also the
 *       command to suggest a better name. ..."
 *
 *   "Go through my repo and refactor all the API calls."
 *   -> "Freya: Generate tests for this code will refactor all the API calls."
 *
 * Granite slog ihop faktaraderna när de blev för täta. Den kortare listan
 * nedan höll isär dem. Lärdomen är att prompten är en MÄTT artefakt, inte en
 * dokumentationstext -- utförligare är inte bättre.
 */
export const GUIDE_SYSTEM = [
	"You are Tungsten's built-in guide. You answer in two or three sentences, never with numbered steps.",
	"",
	"The only settings that exist: freya.autocomplete.enabled (inline completion), freya.nextEdit.enabled (next-edit prediction), freya.syntaxFix.enabled (ghost-text syntax fix), freya.tentative.enabled, freya.instruct.enabled.",
	// ORDNINGEN ÄR MÄTT. Kommandoraden stod FÖRE genvägsraden fram till den här
	// omgången; se "VAD SOM ÄNDRADES" nedan. Byt inte tillbaka utan att köra om
	// alla sju frågorna.
	"Commands: Freya: Explain selected code, Freya: Generate tests for this code, Freya: Suggest a better name, Freya: Second opinion on this code.",
	"The only shortcuts that exist: Ctrl+K (rewrite the selection), Ctrl+K Ctrl+I (same, no selection needed), Ctrl+K Ctrl+R (refactor presets).",
	"Everything runs on this machine: no account, no sign-in, no network.",
	"",
	// "create files" står FÖRST och uttryckligen. Med den gamla lydelsen
	// ("read files, write files") svarade Granite "Sure, I can create a new file
	// for you" på en rak begäran om att skapa en fil -- alltså precis det
	// agent-löfte hela lanen är byggd för att inte ge. Modellen generaliserade
	// inte "write" till "create".
	"You cannot create files, read files, change files, open a repository or run commands. You only see what the user typed.",
	"Answer in the user's language.",
].join("\n");

/**
 * FÅ-SKOTTS-EXEMPEL. Prependas till varje chatt-tur.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VARFÖR DE FINNS -- uppmätt vid modellbytet till Granite, inte antaget.
 *
 * Qwen följde system-prompten ovan rakt av. Granite-3b-code-instruct är en
 * KODMODELL, och den ignorerade den systematiskt på just den här ytan:
 *
 *   "How do I turn off inline completions?"
 *   -> "1. Open the settings by pressing Ctrl+K, Ctrl+S. 2. Navigate to the
 *       Completion section. 3. Uncheck the Inline suggestions option."
 *
 *   Numrerade steg trots förbudet, och tre påhittade ytor: den genvägen, den
 *   sektionen och den inställningen finns inte. FACTS-listan stod i prompten
 *   och lästes inte.
 *
 *   "Go through my repo and refactor all the API calls."
 *   -> "Sure, I can help you with that. Please provide me with the repository
 *       URL so that I can access it."
 *
 *   Alltså exakt den agent-roll prompten förbjuder.
 *
 * Omskrivningar hjälpte inte (två varianter provade, båda föll likadant). Det
 * som fungerade var att VISA svaret i stället för att beskriva det: två
 * exempelturer, en fråga om en inställning och en begäran att röra repot.
 * Efter dem svarade Granite rätt på båda -- rätt inställningsnamn, och ett nej
 * som pekar på Ctrl+K.
 *
 * Exemplen är valda som par med flit: ett som visar FORMATET (kort, ingen
 * numrering, exakt inställningsnamn) och ett som visar GRÄNSEN.
 *
 * TVÅ PAR, INTE TRE. Ett tredje exempel provades -- en "vad gör Ctrl+K Ctrl+R"-
 * fråga besvarad kort -- för att komma åt den kvarvarande svagheten nedan. Det
 * gjorde mätbart SÄMRE ifrån sig på båda hållen: Ctrl+K beskrevs som "the
 * explain dialog", och gränsen sprack igen ("That's a good idea. I can help you
 * with that ... pick the one that says async/await"). Fler exempel är alltså
 * inte monotont bättre för en 3B; de kan dra svaret mot fel exempel. Förkastat.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VAD SOM ÄNDRADES I DEN HÄR OMGÅNGEN, och vad som mättes fram.
 *
 * Utgångspunkten var den kända svagheten: på "vad gör Ctrl+K?" svarade Granite
 * rätt först och rabblade sedan de andra kommandona som om de låg på Ctrl+K.
 * Ett bredare frågebatteri (sju frågor mot den riktiga 3B:n, temperature 0,
 * seed 7) visade att den gamla prompten hade TVÅ fel till som inte var kända:
 *
 *   "What does Ctrl+K Ctrl+R do?"
 *   -> "renames all the references to the symbol under the cursor. It's a
 *       second opinion on the code."          FEL, och två fakta hopslagna.
 *
 *   "Can you create a new file called utils.py for me?"
 *   -> "Sure, I can create a new file for you. Select the text ... then choose
 *       'Create new file'."                   AGENT-LÖFTET, rakt av.
 *
 * Det andra är allvarligast: det är samma felklass som FEL 2 ovan, men den
 * gamla få-skotts-turen täckte bara ÄNDRA befintliga filer, inte SKAPA nya, och
 * modellen generaliserade inte.
 *
 * TVÅ ÄNDRINGAR, båda ovan i GUIDE_SYSTEM:
 *   1. Kommandoraden flyttad FÖRE genvägsraden.
 *   2. "You cannot create files, read files, change files, ..."
 *
 * EFTER:
 *   Ctrl+K Ctrl+R  -> "It applies the refactoring presets to the selection."  RÄTT
 *   skapa fil      -> "I cannot create files -- I only see what you type
 *                      here. Select the code you want changed and press
 *                      Ctrl+K ..."                                           RÄTT
 *   Ctrl+K         -> rätt svar först, ingen punktlista med de andra
 *                     kommandona. Rabblandet är borta.
 *   inställningar, agent-gränsen, nätverksfrågan: oförändrat rätt.
 *
 * FYRA KANDIDATER FÖRKASTADES, var och en för att den regresserade en grind.
 * Skriv inte om raderna utan att köra om alla sju frågorna -- prompten är
 * fortfarande en mätt artefakt och den är MYCKET känslig:
 *
 *   A  kommandoraden omdöpt till "Separate commands in the command palette,
 *      not on Ctrl+K:"  -> agent-gränsen SPRACK ("Freya: Generate tests for
 *      this code will refactor all the API calls"), och Ctrl+K beskrevs som
 *      "the command palette". Att ens nämna paletten förgiftade svaret.
 *   D  som nu men "You cannot create, read or change files"  -> agent-gränsen
 *      sprack på ett nytt sätt ("Set freya.instruct.enabled to true ... will
 *      run the code through the refactorer"). Den korta uppräkningen räcker
 *      inte; verbet måste stå vid "files" varje gång.
 *   E  som nu men Ctrl+K beskriven som "rewrite the selection with an
 *      instruction you type"  -> Ctrl+K Ctrl+R blev fel igen OCH "Sure, I can
 *      create a new file" kom tillbaka. Bekräftar regeln ovan: utförligare är
 *      inte bättre.
 *   B  bara ändring 1, utan ändring 2  -> Ctrl+K och Ctrl+K Ctrl+R blev rätt,
 *      men "Sure, I can create a new file" fanns kvar. Behölls inte, eftersom
 *      ändring 2 är den som stänger agent-löftet.
 *
 * KVARVARANDE SVAGHET, känd och accepterad: på "vad gör Ctrl+K?" svarar Granite
 * numera rätt, men lägger till en jämförelse som inte stämmer ("the same
 * changes as ... the 'Second Opinion' button in the UI" -- det finns ingen
 * sådan knapp). Det är en felaktig hänvisning till en YTA, inte till en
 * inställning, och de två grindar som spelar roll -- rätt inställningsnamn och
 * att den nekar agent-jobb -- klarar den. Varje försök att också få bort den
 * kostade en av de grindarna; se A, D och E.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const GUIDE_SHOTS: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [
	{
		role: "user",
		content: "How do I turn off the ghost-text syntax fix?",
	},
	{
		role: "assistant",
		content:
			"Set freya.syntaxFix.enabled to false in your settings. That stops the faint " +
			"suggestion that appears when the parser sees a missing brace or comma.",
	},
	{
		role: "user",
		content: "Can you open my project and clean up the imports everywhere?",
	},
	{
		role: "assistant",
		content:
			"I cannot open or change files -- I only see what you type here. Select the code " +
			"you want changed and press Ctrl+K, then tell it what to do; you will get a diff " +
			"to approve.",
	},
];

/**
 * Stoppsekvenser för chatt-lanen.
 *
 * Granites chat-mall är `System:` / `Question:` / `Answer:`. Med få-skotts-
 * exemplen på plats fortsatte modellen efter sitt svar och skrev NYA
 * Question/Answer-par -- den hade lärt sig mönstret lite för väl:
 *
 *   "Set freya.autocomplete.enabled to false ...
 *    Question:
 *    How do I turn off the next-edit prediction?
 *    Answer: ..."
 *
 * Stoppen klipper där. De hör ihop med exemplen: tar man bort det ena måste
 * man ompröva det andra.
 */
export const GUIDE_STOP = ["\nQuestion:", "\nSystem:"];
