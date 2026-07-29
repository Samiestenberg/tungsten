// Sökvägskonventionen för de inbäddade modellerna, på ETT ställe.
//
// VARFÖR DEN HÄR FILEN FINNS: när instruct-lanen (3B) tillkom fanns två sätt
// att göra det på. Det ena var att skriva av localServer.ts för hand och hoppas
// att de två kopiorna fortsätter leta på samma ställen. Det andra är det här:
// EN funktion som båda lanerna anropar med olika modellmapp. Konventionen kan
// då inte glida isär, för det finns bara en.
//
// Layouten på disk (identisk i dev-träd och packat bygge, bara roten skiljer):
//
//   <root>/win32-x64/llama-server.exe    delad binär, båda lanerna kör den
//   <root>/model/*.gguf                  1.5B base   -> FIM-lanen, port 11435
//   <root>/model-instruct/*.gguf         3B instruct -> instruct-lanen, 11436
//
// Binären är DELAD med flit: llama-server tar modellen som argument, så två
// processer av samma .exe med olika -m är precis vad vi vill ha. Att bunta två
// kopior av 45 MB DLL:er hade bara varit slöseri.
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

const SERVER_EXE = "llama-server.exe";
const MODEL_GLOB_SUFFIX = ".gguf";

export interface RuntimePaths {
	/** Absolut sökväg till llama-server.exe. */
	exe: string;
	/** Absolut sökväg till GGUF:en för den lane som frågade. */
	model: string;
}

/**
 * Var runtime:n ligger. `vscode.env.appRoot` är resources/app i ett packat
 * bygge och repo-roten i dev, så båda fallen täcks av de två kandidaterna.
 *
 * `configuredRoot` är lanens EGNA override (freya.local.runtimePath respektive
 * freya.instruct.runtimePath). Båda är låsta i restrictedConfigurations, så en
 * obetrodd arbetsyta kan inte peka om vilken binär vi startar.
 */
export function runtimeRoots(configuredRoot?: string): string[] {
	const roots = configuredRoot ? [configuredRoot] : [];
	const appRoot = vscode.env.appRoot;
	roots.push(
		path.join(appRoot, "freya-runtime"), // packat bygge
		path.join(appRoot, "resources", "freya-runtime") // dev-träd
	);
	if (downloadRoot) {
		roots.push(downloadRoot); // hämtat vid första körningen, se nedan
	}
	return roots;
}

/**
 * Mappen dit modeller som hämtas vid första körningen skrivs.
 *
 * VARFÖR DEN BEHÖVS: den lilla installern (byggd med FREYA_BUNDLE_INSTRUCT=0)
 * har ingen 3B med sig -- den ryms inte under GitHubs 2 GiB-tak per fil. Då
 * hämtas modellen vid första användningen i stället. Den kan INTE skrivas till
 * resources/app: den mappen ligger under Program Files och är skrivskyddad för
 * en användarinstallation. Alltså extensionens globalStorage, som registreras
 * av extension.ts vid uppstart.
 *
 * Roten läggs SIST i listan med flit. En buntad modell i det packade bygget
 * vinner alltid över en hämtad -- annars hade en gammal nedladdning kunnat
 * skugga den modell som faktiskt shippades.
 */
let downloadRoot: string | undefined;

export function setDownloadRoot(root: string): void {
	downloadRoot = root;
}

export function getDownloadRoot(): string | undefined {
	return downloadRoot;
}

/** llama-server.exe i den första rot som har den. Alltid buntad med bygget. */
export function findServerExe(configuredRoot?: string): string | undefined {
	for (const root of runtimeRoots(configuredRoot)) {
		const exe = path.join(root, process.platform === "win32" ? "win32-x64" : "", SERVER_EXE);
		if (fs.existsSync(exe)) {
			return exe;
		}
	}
	return undefined;
}

/** Första GGUF:en i `modelSubdir`, i den första rot som har en. */
export function findModel(
	modelSubdir: string,
	configuredRoot?: string
): string | undefined {
	for (const root of runtimeRoots(configuredRoot)) {
		const modelDir = path.join(root, modelSubdir);
		if (!fs.existsSync(modelDir)) {
			continue;
		}
		const model = fs
			.readdirSync(modelDir)
			.filter((f) => f.toLowerCase().endsWith(MODEL_GLOB_SUFFIX))
			.sort()[0];
		if (model) {
			return path.join(modelDir, model);
		}
	}
	return undefined;
}

/**
 * Hittar binär + modell för en lane, eller undefined om något saknas.
 *
 * BINÄREN OCH MODELLEN FÅR KOMMA FRÅN OLIKA RÖTTER. Det kravet lättades när
 * den lilla installern tillkom, och det är hela poängen med den: llama-server
 * följer alltid med i bygget (~45 MB), medan GGUF:en kan ha hämtats vid första
 * körningen till globalStorage. Tidigare krävdes samma rot för båda, vilket
 * hade gjort en hämtad modell osynlig oavsett att den låg där.
 *
 * Det som gick förlorat med det gamla kravet var ett tydligare felmeddelande
 * vid en halv installation. Det vägs upp av att modellsökningen numera säger
 * exakt vilken av de två delarna som saknas -- se instructServer.ts.
 */
export function findRuntime(
	configuredRoot: string | undefined,
	modelSubdir: string
): RuntimePaths | undefined {
	const exe = findServerExe(configuredRoot);
	if (!exe) {
		return undefined;
	}
	const model = findModel(modelSubdir, configuredRoot);
	return model ? { exe, model } : undefined;
}

/**
 * Nyckeln är HÄRLEDD, inte slumpad: varje fönster räknar fram samma nyckel, så
 * ett andra fönster kan återanvända en server som redan kör i stället för att
 * ladda modellen en gång till. Poängen med nyckeln är att llama-server sätter
 * CORS till '*' -- utan den kan en godtycklig webbsida du besöker POSTa till
 * 127.0.0.1 och använda din CPU. En webbsida kan inte räkna fram den här.
 *
 * Modellsökvägen ingår i hashen, så 1.5B:n och 3B:n får OLIKA nycklar. Det är
 * inte kosmetik: det är det som gör att en probe mot fel port inte kan
 * misstas för rätt server.
 */
export function derivedApiKey(modelPath: string): string {
	return crypto
		.createHash("sha256")
		.update(`freya-local:${modelPath}:${vscode.env.machineId}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * Lyssnar NÅGON på porten? Säger inget om VEM -- bara att den är upptagen.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VARFÖR DEN BEHÖVS -- uppmätt på Windows, inte antaget.
 *
 * Det stod tidigare i instructPort() att en portkrock skulle betyda att vi
 * pratar med fel modell. Det stämmer inte, och det som faktiskt händer är
 * värre på ett annat sätt. Mätning med två llama-server på samma port:
 *
 *   Den andra processen klagar INTE. Den skriver "model loaded" och
 *   "listening on http://127.0.0.1:18437" precis som vanligt -- men det finns
 *   bara EN lyssnande socket, och den FÖRSTA behåller den. Alla anrop går till
 *   den som hann först; den andra får aldrig en enda anslutning.
 *
 * Följden i den gamla koden: vi läste in 2 GB i en process som inte kunde ta
 * emot något, probade i 90 sekunder mot någon annans server som svarade 401 på
 * vår nyckel, gav upp och sa "the 3B instruct model is not installed in this
 * build" -- alltså fel diagnos, efter en och en halv minuts tystnad.
 *
 * Att vi inte fick FEL MODELL är den härledda API-nyckelns förtjänst: någon
 * annans server har en annan nyckel och svarar 401 i stället för att generera.
 * Den delen av konstruktionen höll. Se derivedApiKey() ovan.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function portListening(port: number, timeoutMs = 400): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = new net.Socket();
		const done = (answer: boolean) => {
			socket.destroy();
			resolve(answer);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
		socket.connect(port, "127.0.0.1");
	});
}

/**
 * Redo OCH vår. Vi frågar /props och inte /health med flit: llama-server
 * lämnar /health öppet (verifierat: 200 utan nyckel) medan /props och /infill
 * svarar 401 utan rätt nyckel. En hälsokoll mot /health skulle alltså säga "ja"
 * även om det är någon ANNAN llama-server på porten -- och då hade varje
 * efterföljande anrop fallit på 401. /props svarar 200 bara om nyckeln stämmer,
 * vilket är exakt villkoret för att vi ska få återanvända servern.
 */
export async function probeReady(
	baseUrl: string,
	apiKey: string,
	timeoutMs = 1500
): Promise<boolean> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl}/props`, {
			signal: ac.signal,
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
