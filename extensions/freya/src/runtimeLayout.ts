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
	return roots;
}

/**
 * Hittar binär + modell för en lane, eller undefined om något saknas.
 *
 * Kravet att BÅDA ska finnas i SAMMA rot är avsiktligt: en halv installation
 * (binär från det packade bygget, modell från en handredigerad sökväg) är
 * svårare att felsöka än ett rent "saknas".
 */
export function findRuntime(
	configuredRoot: string | undefined,
	modelSubdir: string
): RuntimePaths | undefined {
	for (const root of runtimeRoots(configuredRoot)) {
		const exe = path.join(root, process.platform === "win32" ? "win32-x64" : "", SERVER_EXE);
		const modelDir = path.join(root, modelSubdir);
		if (!fs.existsSync(exe) || !fs.existsSync(modelDir)) {
			continue;
		}
		const model = fs
			.readdirSync(modelDir)
			.filter((f) => f.toLowerCase().endsWith(MODEL_GLOB_SUFFIX))
			.sort()[0];
		if (model) {
			return { exe, model: path.join(modelDir, model) };
		}
	}
	return undefined;
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
