/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Hämtar Freyas inbäddade lokala runtime till resources/freya-runtime/.
//
//   node --experimental-strip-types build/freya/fetchLocalRuntime.ts
//
// Tre delar:
//   1. llama.cpp-server, prebuilt CPU-bygge för win32-x64 från llama.cpp:s
//      officiella GitHub-release. CPU-bygget och inte CUDA/Vulkan: en 1.5B
//      går tillräckligt fort på CPU (~390 ms per komplettering mätt), och
//      kompatibilitet på VILKEN maskin som helst är viktigare än hastighet.
//      Zip:en innehåller ett dussin ggml-cpu-*.dll (sse42, x64, sandybridge,
//      ivybridge, haswell, skylakex, icelake, alderlake, zen4 ...) som väljs i
//      runtime, så även en CPU utan AVX2 fungerar. BINÄREN ÄR DELAD av båda
//      modellerna -- llama-server tar modellen som argument.
//   2. model/       GGUF (Qwen2.5-Coder-1.5B BASE, Q4_K_M) -> FIM-lanen, 11435.
//   3. model-instruct/ GGUF (Qwen2.5-Coder-3B INSTRUCT, Q4_K_M) -> instruct-
//      lanen, 11436. Base kan inte följa en instruktion och instruct är sämre
//      på FIM, så det är två modeller för två roller -- inte redundans.
//
// LICENSER (kontrollerade):
//   llama.cpp ...................... MIT
//   Qwen2.5-Coder-1.5B (base) ...... Apache-2.0
//   Qwen2.5-Coder-3B-Instruct ...... Qwen RESEARCH License  <-- LÄS DETTA
//
// VARNING OM 3B:N. Qwen2.5-Coder är Apache-2.0 i alla storlekar UTOM 3B, som
// ligger under Qwen Research License och därmed inte tillåter kommersiell
// användning. Modellen är specificerad uppifrån och hämtas därför som beställd,
// men för ett kommersiellt distribuerat bygge måste den bytas. Bytet är EN
// konstant: sätt INSTRUCT_MODEL till ett Apache-2.0-alternativ i samma
// storleksklass -- ibm-granite/granite-3b-code-instruct-128k-GGUF är det
// närmaste (Apache-2.0, coder-instruct, ~2 GB i Q4_K_M).
//
// resources/freya-runtime/ är GITIGNORE:AD med flit: ~3 GB modellvikter hör
// inte i git-historiken. Saknas model/ faller FIM-lanen tillbaka på Ollama;
// saknas model-instruct/ är instruct-funktionerna avstängda och säger det.

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const RUNTIME_DIR = path.join(REPO_ROOT, 'resources', 'freya-runtime');
const BIN_DIR = path.join(RUNTIME_DIR, 'win32-x64');
const MODEL_DIR = path.join(RUNTIME_DIR, 'model');
const INSTRUCT_MODEL_DIR = path.join(RUNTIME_DIR, 'model-instruct');

/** Pinnad llama.cpp-release. Höj medvetet, inte automatiskt. */
const LLAMA_BUILD = 'b10149';
const LLAMA_ASSET = `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`;
const LLAMA_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}`;
/** sha256 för LLAMA_ASSET, verifierad vid nedladdning. */
const LLAMA_SHA256 = '2a366996e7f400d1f298b5cf0f2d276eed411bfa57a4b09a7c54c28d594913aa';

const MODEL_FILE = 'qwen2.5-coder-1.5b-base-q4_k_m.gguf';
/**
 * Modellen hämtas i första hand från en lokal Ollama-installation: exakt samma
 * GGUF, redan på disk, ingen ny nedladdning och ingen ny leverantör att lita
 * på. `ollama pull qwen2.5-coder:1.5b-base` lägger den där.
 */
const OLLAMA_MODEL_REF = 'qwen2.5-coder:1.5b-base';

/**
 * INSTRUCT-MODELLEN (3B-lanen). Ett byte av modell ska vara ett byte av det
 * här objektet och ingenting annat -- se licensvarningen i filhuvudet.
 *
 * Till skillnad från 1.5B:n hämtas den från HuggingFace och inte ur en lokal
 * Ollama-installation. Skälet är produktlöftet: bygget får inte kräva att
 * någon kört `ollama pull` först. Finns GGUF:en ändå i en lokal Ollama
 * används den (samma fil, ingen ny nedladdning) -- men det är en genväg, inte
 * ett krav.
 */
const INSTRUCT_MODEL = {
	file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
	url:
		'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/' +
		'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
	/** Verifierad på den hämtade filen 2026-07-29. */
	sha256: '724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7',
	bytes: 2_104_932_800,
	/** Ollama-taggen med samma vikter, om den råkar finnas lokalt. */
	ollamaRef: 'qwen2.5-coder:3b-instruct-q4_K_M',
	license: 'Qwen Research License (INTE Apache-2.0 -- se filhuvudet)',
	licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct/blob/main/LICENSE',
	homepage: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF',
};

function log(msg: string): void {
	console.log(`[freya-runtime] ${msg}`);
}

function sha256File(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Som sha256File(), men läser i bitar. En 2 GB-fil ska inte in i heapen. */
function sha256FileStreaming(file: string): string {
	const hash = crypto.createHash('sha256');
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.allocUnsafe(8 * 1048576);
		for (;;) {
			const read = fs.readSync(fd, buf, 0, buf.length, null);
			if (read <= 0) { break; }
			hash.update(buf.subarray(0, read));
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest('hex');
}

async function download(url: string, dest: string): Promise<void> {
	log(`hämtar ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`${res.status} ${res.statusText} för ${url}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(dest, buf);
	log(`skrev ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

/**
 * Som download(), men STRÖMMAR till disk. En 2 GB-modell får inte gå via en
 * Buffer i minnet: det är i bästa fall 2 GB heap-tryck och i sämsta fall ett
 * hårt tak i Node. Skriver till .part och byter namn först när hela filen är
 * nere, så ett avbrutet bygge inte lämnar en halv GGUF som ser färdig ut.
 */
async function downloadStreaming(url: string, dest: string, expectedBytes?: number): Promise<void> {
	log(`hämtar ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) {
		throw new Error(`${res.status} ${res.statusText} för ${url}`);
	}

	const part = `${dest}.part`;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const out = fs.createWriteStream(part);
	let written = 0;
	let nextReport = 128 * 1048576;

	try {
		// @ts-expect-error -- ReadableStream är async-itererbar i Node 18+
		for await (const chunk of res.body) {
			written += chunk.length;
			if (!out.write(chunk)) {
				await new Promise<void>(resolve => out.once('drain', () => resolve()));
			}
			if (written >= nextReport) {
				log(`  ${(written / 1048576).toFixed(0)} MB ...`);
				nextReport += 128 * 1048576;
			}
		}
	} catch (err) {
		out.destroy();
		fs.rmSync(part, { force: true });
		throw err;
	}

	await new Promise<void>((resolve, reject) => {
		out.once('error', reject);
		out.end(() => resolve());
	});

	if (expectedBytes !== undefined && written !== expectedBytes) {
		fs.rmSync(part, { force: true });
		throw new Error(`fel storlek: fick ${written} bytes, förväntade ${expectedBytes}`);
	}

	fs.renameSync(part, dest);
	log(`skrev ${dest} (${(written / 1048576).toFixed(1)} MB)`);
}

async function fetchServerBinary(): Promise<void> {
	if (fs.existsSync(path.join(BIN_DIR, 'llama-server.exe'))) {
		log('llama-server.exe finns redan — hoppar över');
		return;
	}

	const tmp = path.join(os.tmpdir(), LLAMA_ASSET);
	if (!fs.existsSync(tmp) || sha256File(tmp) !== LLAMA_SHA256) {
		await download(LLAMA_URL, tmp);
	}

	const actual = sha256File(tmp);
	if (actual !== LLAMA_SHA256) {
		throw new Error(`sha256 stämmer inte för ${LLAMA_ASSET}\n  förväntad: ${LLAMA_SHA256}\n  faktisk:   ${actual}`);
	}
	log('sha256 OK');

	fs.mkdirSync(BIN_DIR, { recursive: true });
	// Hela arkivet packas upp. Att handplocka DLL:er sparar ~7 MB av 45 och
	// riskerar en saknad load-time-dependency; modellen är 940 MB, så det är
	// inte där storleken ligger.
	const res = cp.spawnSync(
		'powershell',
		['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${tmp}' -DestinationPath '${BIN_DIR}' -Force`],
		{ stdio: 'inherit' }
	);
	if (res.status !== 0) {
		throw new Error(`uppackning misslyckades (exit ${res.status})`);
	}
	log(`packade upp till ${BIN_DIR}`);
}

/** Hittar GGUF-blobben för en given Ollama-tagg i en lokal installation. */
function findOllamaBlob(ref: string = OLLAMA_MODEL_REF): string | undefined {
	const home = os.homedir();
	const [name, tag] = ref.split(':');
	const manifest = path.join(
		process.env.OLLAMA_MODELS ?? path.join(home, '.ollama', 'models'),
		'manifests', 'registry.ollama.ai', 'library', name, tag
	);
	if (!fs.existsSync(manifest)) {
		return undefined;
	}
	const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
	const layer = (parsed.layers ?? []).find((l: any) => l.mediaType === 'application/vnd.ollama.image.model');
	if (!layer) {
		return undefined;
	}
	const blob = path.join(
		process.env.OLLAMA_MODELS ?? path.join(home, '.ollama', 'models'),
		'blobs',
		String(layer.digest).replace(':', '-')
	);
	return fs.existsSync(blob) ? blob : undefined;
}

function fetchModel(): void {
	const dest = path.join(MODEL_DIR, MODEL_FILE);
	if (fs.existsSync(dest)) {
		log(`${MODEL_FILE} finns redan — hoppar över`);
		return;
	}

	const blob = findOllamaBlob();
	if (!blob) {
		throw new Error(
			`hittade ingen lokal GGUF för ${OLLAMA_MODEL_REF}.\n` +
			`  Kör:  ollama pull ${OLLAMA_MODEL_REF}\n` +
			`  och kör sedan det här skriptet igen. (Alternativt: lägg en\n` +
			`  Q4_K_M-GGUF av Qwen2.5-Coder-1.5B base som\n` +
			`  ${dest})`
		);
	}

	fs.mkdirSync(MODEL_DIR, { recursive: true });
	log(`kopierar modell från ${blob}`);
	fs.copyFileSync(blob, dest);

	const header = fs.readFileSync(dest, { encoding: 'latin1', flag: 'r' }).slice(0, 4);
	if (header !== 'GGUF') {
		fs.rmSync(dest);
		throw new Error('den kopierade filen är inte en GGUF (fel magic)');
	}
	log(`skrev ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB, GGUF-magic OK)`);
}

/** Läser de fyra magic-byten utan att dra in hela filen. */
function assertGguf(file: string): void {
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.allocUnsafe(4);
		fs.readSync(fd, buf, 0, 4, 0);
		if (buf.toString('latin1') !== 'GGUF') {
			throw new Error(`${path.basename(file)} är inte en GGUF (fel magic)`);
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * INSTRUCT-modellen (3B-lanen). HuggingFace i första hand, lokal Ollama som
 * genväg. Verifierar storlek OCH sha256 -- en modell som buntas i en installer
 * ska inte kunna vara en annan fil än den vi granskade.
 */
async function fetchInstructModel(): Promise<void> {
	const dest = path.join(INSTRUCT_MODEL_DIR, INSTRUCT_MODEL.file);
	if (fs.existsSync(dest)) {
		log(`${INSTRUCT_MODEL.file} finns redan — hoppar över`);
		return;
	}

	fs.mkdirSync(INSTRUCT_MODEL_DIR, { recursive: true });

	// Genväg: samma vikter kan redan ligga i en lokal Ollama.
	const blob = findOllamaBlob(INSTRUCT_MODEL.ollamaRef);
	if (blob && fs.statSync(blob).size === INSTRUCT_MODEL.bytes) {
		log(`kopierar instruct-modellen från ${blob}`);
		fs.copyFileSync(blob, dest);
	} else {
		await downloadStreaming(INSTRUCT_MODEL.url, dest, INSTRUCT_MODEL.bytes);
	}

	assertGguf(dest);

	const actual = sha256FileStreaming(dest);
	if (actual !== INSTRUCT_MODEL.sha256) {
		fs.rmSync(dest, { force: true });
		throw new Error(
			`sha256 stämmer inte för ${INSTRUCT_MODEL.file}\n` +
			`  förväntad: ${INSTRUCT_MODEL.sha256}\n` +
			`  faktisk:   ${actual}`
		);
	}
	log(`${INSTRUCT_MODEL.file}: sha256 OK, GGUF-magic OK`);
}

function writeLicenseNotice(): void {
	const notice = [
		'Freyas inbäddade lokala runtime',
		'==============================',
		'',
		`llama.cpp-server, build ${LLAMA_BUILD} (win32-x64, CPU)`,
		'  Källa:  ' + LLAMA_URL,
		'  Licens: MIT — Copyright (c) 2023-2026 The ggml authors',
		'  https://github.com/ggml-org/llama.cpp/blob/master/LICENSE',
		'',
		`Modell (FIM-lanen): ${MODEL_FILE}`,
		'  Qwen2.5-Coder-1.5B (base), kvantiserad till Q4_K_M',
		'  Licens: Apache-2.0',
		'  https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B',
		'',
		`Modell (instruct-lanen): ${INSTRUCT_MODEL.file}`,
		'  Qwen2.5-Coder-3B-Instruct, kvantiserad till Q4_K_M',
		`  Licens: ${INSTRUCT_MODEL.license}`,
		`  ${INSTRUCT_MODEL.licenseUrl}`,
		`  ${INSTRUCT_MODEL.homepage}`,
		'',
		'  OBS: Qwen2.5-Coder är Apache-2.0 i alla storlekar UTOM 3B, som ligger',
		'  under Qwen Research License. Den licensen tillåter vidaredistribution',
		'  för forskning och utvärdering men INTE kommersiell användning. För ett',
		'  kommersiellt bygge måste modellen bytas mot ett Apache-2.0-alternativ',
		'  i samma storleksklass (t.ex. granite-3b-code-instruct-128k). Bytet är',
		'  konstanten INSTRUCT_MODEL i build/freya/fetchLocalRuntime.ts.',
		'',
		'llama.cpp- och 1.5B-licenserna tillåter vidaredistribution i binär form.',
		'Den här filen följer med i det packade bygget som attribution.',
		''
	].join('\n');
	fs.mkdirSync(RUNTIME_DIR, { recursive: true });
	fs.writeFileSync(path.join(RUNTIME_DIR, 'THIRD-PARTY-NOTICES.txt'), notice);
	log('skrev THIRD-PARTY-NOTICES.txt');
}

async function main(): Promise<void> {
	await fetchServerBinary();
	fetchModel();
	// FREYA_SKIP_INSTRUCT=1 hoppar över 3B:n. Finns för den som bara arbetar på
	// FIM-lanen och inte vill vänta på 2 GB; bygget hanterar en saknad
	// model-instruct/ genom att stänga av instruct-funktionerna.
	if (process.env.FREYA_SKIP_INSTRUCT === '1') {
		log('FREYA_SKIP_INSTRUCT=1 — hoppar över instruct-modellen');
	} else {
		await fetchInstructModel();
	}
	writeLicenseNotice();
	log('klart');
}

main().catch(err => {
	console.error(`[freya-runtime] MISSLYCKADES: ${err.message}`);
	process.exit(1);
});
