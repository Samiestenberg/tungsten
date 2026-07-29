// Hämtning av modeller vid FÖRSTA KÖRNINGEN.
//
// ─────────────────────────────────────────────────────────────────────────
// VARFÖR DEN HÄR FILEN FINNS
//
// Tungsten distribueras i två former, och skillnaden är ett tak hos GitHub:
//
//   BUNTAD    båda modellerna ligger i installern. ~3 GB, en zip, ingen
//             nedladdning, ingen väntan. Distribueras via egen host.
//   LITEN     bara 1.5B:n följer med. ~1,1 GB, en enda .exe som ryms under
//             GitHub-releasernas tak på 2 GiB per fil. 3B:n hämtas här,
//             första gången någon använder en instruct-funktion.
//
// Bygget väljer form med FREYA_BUNDLE_INSTRUCT. Koden är densamma i båda:
// finns modellen på disk används den, annars erbjuds den här hämtningen.
//
// URL:EN ÄR KONFIGURERBAR, och det är ett krav och inte en finess. Default
// pekar på IBM:s egen HuggingFace-repo. Den som vill lägga vikterna på sin
// egen host (R2, en intern spegel, en luftgapad filserver) sätter
// freya.runtime.baseUrl och behöver inte bygga om något. Ingen intern eller
// hårdkodad adress får finnas här -- se privacy.test.ts, som faller på en
// URL som inte är 127.0.0.1 eller en känd modellvärd.
//
// SHA-256 ÄR PINNAD OCH VERIFIERAS. En modell som hämtas över nätet och sedan
// spawnas som en barnprocess är exakt den sortens fil man inte får lita på
// för att den råkade ha rätt namn. Stämmer inte hashen raderas filen.
// ─────────────────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getDownloadRoot } from "./runtimeLayout.js";

/**
 * Modellerna som går att hämta. sha256 och storlek är HÅRDKODADE och måste
 * matcha build/freya/fetchLocalRuntime.ts -- samma vikter, samma kontroll,
 * oavsett om de kom via installern eller över nätet.
 */
interface DownloadableModel {
  /** Undermappen under runtime-roten. */
  readonly subdir: string;
  /** Filnamnet på disk, och sista delen av URL:en. */
  readonly file: string;
  /** Sökvägen efter baseUrl. Bara den här delen är hårdkodad. */
  readonly urlPath: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Visas för användaren. */
  readonly label: string;
}

export const INSTRUCT_DOWNLOAD: DownloadableModel = {
  subdir: "model-instruct",
  file: "granite-3b-code-instruct.Q4_K_M.gguf",
  urlPath:
    "ibm-granite/granite-3b-code-instruct-2k-GGUF/resolve/main/" +
    "granite-3b-code-instruct.Q4_K_M.gguf",
  bytes: 2_132_498_112,
  sha256: "5bd783ab3925f425f17764fd34c1f7119fb64a023ccf9dd48654c3c3f252a8ff",
  label: "Granite-3B-Code-Instruct (2.1 GB)",
};

export const COMPLETION_DOWNLOAD: DownloadableModel = {
  subdir: "model",
  file: "qwen2.5-coder-1.5b-base-q4_k_m.gguf",
  urlPath:
    "Qwen/Qwen2.5-Coder-1.5B-GGUF/resolve/main/qwen2.5-coder-1.5b-q4_k_m.gguf",
  bytes: 986_048_000,
  // Tom = ingen hashkontroll. 1.5B:n buntas ALLTID i båda installerformerna,
  // så den här posten är en nödutgång för ett dev-träd, inte en normal väg.
  // Hellre en ärlig tom sträng än en påhittad hash.
  sha256: "",
  label: "Qwen2.5-Coder-1.5B (0.9 GB)",
};

/** Standardvärden. Ändras av användaren via freya.runtime.baseUrl. */
const DEFAULT_BASE_URL = "https://huggingface.co";

function cfg() {
  return vscode.workspace.getConfiguration("freya");
}

/**
 * Bas-URL:en för hämtning. Avslutande snedstreck normaliseras bort, så att en
 * adress med och utan slut-snedstreck beter sig lika -- den sortens detalj är
 * annars ett supportärende.
 */
export function downloadBaseUrl(): string {
  const configured = cfg().get<string>("runtime.baseUrl")?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function downloadUrlFor(model: DownloadableModel): string {
  return `${downloadBaseUrl()}/${model.urlPath}`;
}

/** Var en hämtad modell hamnar. undefined innan extension.ts registrerat roten. */
function destinationFor(model: DownloadableModel): string | undefined {
  const root = getDownloadRoot();
  return root ? path.join(root, model.subdir, model.file) : undefined;
}

/** Läser filen i bitar. En 2 GB-fil ska inte in i heapen. */
function sha256Streaming(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(8 * 1048576);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Hämtar en modell med progress, avbrytbart.
 *
 * Skriver till .part och byter namn först när filen är hel OCH verifierad --
 * samma mönster som byggskriptet. Ett avbrutet eller trasigt bygge får inte
 * lämna en halv GGUF som ser färdig ut, för nästa start skulle då försöka
 * ladda den.
 */
async function downloadModel(
  model: DownloadableModel,
  dest: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<void> {
  const url = downloadUrlFor(model);
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());

  try {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal });
    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }

    const out = fs.createWriteStream(part);
    let written = 0;
    let lastPercent = 0;

    try {
      for await (const chunk of res.body) {
        written += chunk.length;
        if (!out.write(chunk)) {
          await new Promise<void>((r) => out.once("drain", () => r()));
        }
        const percent = Math.floor((written / model.bytes) * 100);
        if (percent > lastPercent) {
          progress.report({
            increment: percent - lastPercent,
            message: `${(written / 1048576).toFixed(0)} MB of ${(model.bytes / 1048576).toFixed(0)} MB`,
          });
          lastPercent = percent;
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }

    if (written !== model.bytes) {
      throw new Error(
        `wrong size: got ${written} bytes, expected ${model.bytes}. ` +
          `Check that ${downloadBaseUrl()} serves the same file.`
      );
    }

    progress.report({ message: "verifying..." });
    if (model.sha256) {
      const actual = sha256Streaming(part);
      if (actual !== model.sha256) {
        throw new Error(
          `checksum mismatch.\n  expected ${model.sha256}\n  got      ${actual}`
        );
      }
    }

    fs.renameSync(part, dest);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  } finally {
    sub.dispose();
  }
}

/**
 * Frågar användaren och hämtar. true = modellen finns nu på disk.
 *
 * ALLTID EN FRÅGA, aldrig en tyst nedladdning. 2,1 GB över någons uppkoppling
 * är inte något en editor får starta självmant, och storleken står i frågan.
 */
export async function offerDownload(
  model: DownloadableModel
): Promise<boolean> {
  const dest = destinationFor(model);
  if (!dest) {
    return false;
  }
  if (fs.existsSync(dest)) {
    return true;
  }

  const answer = await vscode.window.showInformationMessage(
    `Freya needs ${model.label} for this. It runs entirely on your machine once downloaded.`,
    { modal: true, detail: `From: ${downloadBaseUrl()}\nTo: ${dest}` },
    "Download"
  );
  if (answer !== "Download") {
    return false;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${model.label}`,
        cancellable: true,
      },
      (progress, token) => downloadModel(model, dest, progress, token)
    );
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return false;
    }
    vscode.window.showErrorMessage(
      `Freya could not download the model: ${String(err?.message ?? err)}`
    );
    return false;
  }

  return fs.existsSync(dest);
}

export function registerModelDownload(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("freya.downloadInstructModel", async () => {
      const ok = await offerDownload(INSTRUCT_DOWNLOAD);
      if (ok) {
        vscode.window.showInformationMessage(
          "Freya: the instruct model is ready. Explain, rewrite, fix, tests and chat now work."
        );
      }
    })
  );
}
