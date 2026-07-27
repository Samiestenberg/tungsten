/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Hämtar Freyas inbäddade lokala runtime till resources/freya-runtime/.
//
//   node --experimental-strip-types build/freya/fetchLocalRuntime.ts
//
// Två delar:
//   1. llama.cpp-server, prebuilt CPU-bygge för win32-x64 från llama.cpp:s
//      officiella GitHub-release. CPU-bygget och inte CUDA/Vulkan: en 1.5B
//      går tillräckligt fort på CPU (~390 ms per komplettering mätt), och
//      kompatibilitet på VILKEN maskin som helst är viktigare än hastighet.
//      Zip:en innehåller ett dussin ggml-cpu-*.dll (sse42, x64, sandybridge,
//      ivybridge, haswell, skylakex, icelake, alderlake, zen4 ...) som väljs i
//      runtime, så även en CPU utan AVX2 fungerar.
//   2. GGUF-modellen (Qwen2.5-Coder-1.5B base, Q4_K_M).
//
// LICENSER (kontrollerade, se README i samma mapp):
//   llama.cpp .................. MIT
//   Qwen2.5-Coder-1.5B (base) .. Apache-2.0
// Båda tillåter vidaredistribution i en packad app. Licenstexterna kopieras
// till resources/freya-runtime/ av det här skriptet.
//
// resources/freya-runtime/ är GITIGNORE:AD med flit: ~1 GB modellvikter hör
// inte i git-historiken. Saknas mappen faller Freya tillbaka på Ollama, vilket
// är exakt vad ett dev-träd utan runtime ska göra.

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

function log(msg: string): void {
	console.log(`[freya-runtime] ${msg}`);
}

function sha256File(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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

/** Hittar GGUF-blobben i en lokal Ollama-installation. */
function findOllamaBlob(): string | undefined {
	const home = os.homedir();
	const [name, tag] = OLLAMA_MODEL_REF.split(':');
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
		`Modell: ${MODEL_FILE}`,
		'  Qwen2.5-Coder-1.5B (base), kvantiserad till Q4_K_M',
		'  Licens: Apache-2.0',
		'  https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B',
		'',
		'Båda licenserna tillåter vidaredistribution i binär form. Den här filen',
		'följer med i det packade bygget som attribution.',
		''
	].join('\n');
	fs.mkdirSync(RUNTIME_DIR, { recursive: true });
	fs.writeFileSync(path.join(RUNTIME_DIR, 'THIRD-PARTY-NOTICES.txt'), notice);
	log('skrev THIRD-PARTY-NOTICES.txt');
}

async function main(): Promise<void> {
	await fetchServerBinary();
	fetchModel();
	writeLicenseNotice();
	log('klart');
}

main().catch(err => {
	console.error(`[freya-runtime] MISSLYCKADES: ${err.message}`);
	process.exit(1);
});
