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
import { pipeline } from "stream/promises";
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

/**
 * 1.5B:n. GÅR INTE ATT HÄMTA -- posten är beskrivande, inte en väg.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEN TOMMA HASHEN, och varför den får stå kvar.
 *
 * Frågan var om sha256: "" kan nå en nedladdningsväg, för då hade vi hämtat
 * en GGUF över nätet UTAN att kontrollera den och sedan spawnat den som en
 * barnprocess. Svaret är nej, och det är kontrollerat och inte resonerat:
 *
 *   offerDownload() anropas på exakt två ställen -- ensureInstructReady() i
 *   instructModel.ts och kommandot freya.downloadInstructModel -- och BÅDA
 *   skickar INSTRUCT_DOWNLOAD. COMPLETION_DOWNLOAD har noll anropsställen i
 *   hela tillägget.
 *
 * Men "ingen anropar den idag" är ett svagt skydd: konstanten är exporterad,
 * och den som kopplar in den om ett år har ingen anledning att misstänka att
 * hashkontrollen tyst hoppas över. Så grinden sitter i downloadModel() i
 * stället, där den inte går att missa. Se kommentaren där.
 *
 * Storleken var dessutom FEL -- 986 048 000 mot filens faktiska 986 048 512 --
 * vilket är ett bevis i sig på att posten aldrig kördes: en hämtning hade
 * fallit på storlekskontrollen varje gång. Rättad, så att den som väcker
 * posten börjar från något sant.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const COMPLETION_DOWNLOAD: DownloadableModel = {
  subdir: "model",
  file: "qwen2.5-coder-1.5b-base-q4_k_m.gguf",
  urlPath:
    "Qwen/Qwen2.5-Coder-1.5B-GGUF/resolve/main/qwen2.5-coder-1.5b-q4_k_m.gguf",
  bytes: 986_048_512,
  // Tom = INGEN hash är känd för den här filen. 1.5B:n buntas alltid i båda
  // installerformerna, så den har aldrig behövt hämtas och ingen hash har
  // därför mätts upp. Hellre en ärlig tom sträng än en påhittad -- och
  // downloadModel() VÄGRAR hämta en modell utan hash, så tomheten kan inte
  // bli till en tyst genväg.
  sha256: "",
  label: "Qwen2.5-Coder-1.5B (0.9 GB)",
};

/**
 * Standardvärdet. Ändras av användaren via freya.runtime.baseUrl.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VARFÖR TUNGSTENS EGEN BUCKET OCH INTE HUGGINGFACE.
 *
 * Den lilla installern (D2) måste kunna hämta 3B:n på en ren maskin utan att
 * användaren konfigurerar något. Den vägen behöver alltså en default som
 * FAKTISKT fungerar, och den ska peka på vikter vi har kontrollerat själva:
 * objektet i bucketen är byte-för-byte samma fil som buntas i D1, verifierat
 * genom att hasha objektet på serversidan efter uppladdningen.
 *
 *   lokal fil    2 132 498 112 B   sha256 5bd783ab…f252a8ff
 *   R2-objektet  2 132 498 112 B   sha256 5bd783ab…f252a8ff
 *
 * HuggingFace fungerar fortfarande, och SÖKVÄGEN under basen är med flit
 * identisk med deras (`<repo>/resolve/main/<fil>`). Att byta tillbaka är
 * därför bara att sätta om den här inställningen till https://huggingface.co
 * -- ingen ombyggnad, ingen kodändring. Det var själva poängen med att välja
 * den nyckeln i bucketen.
 *
 * Skälet att inte lita på HuggingFace som default är inte misstro mot dem utan
 * att vi inte STYR filen där: ett nytt upload i deras repo ändrar hashen, och
 * då vägrar installern filen -- korrekt, men användaren sitter med en 3B som
 * inte går att hämta.
 *
 * KÄNT FÖRBEHÅLL: pub-*.r2.dev är Cloudflares utvecklings-URL och den är
 * hastighetsbegränsad; Cloudflare avråder från den för produktionstrafik. Den
 * är rätt val NU (stabil, publik, kräver ingen auth), men den dagen hämtningen
 * blir varm hör den hemma på en egen domän framför samma bucket. Byt då bara
 * den här strängen -- nyckeln under basen är oförändrad.
 * ─────────────────────────────────────────────────────────────────────────
 */
const DEFAULT_BASE_URL = "https://pub-7ae5d28171f348d19d1b8f1db9ab7253.r2.dev";

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

/**
 * Hur gammal en övergiven temp-fil måste vara innan vi städar bort den.
 * Rejält tilltaget: en PÅGÅENDE hämtning i ett annat fönster får aldrig
 * råka räknas som skräp. 2,1 GB tar minuter, inte timmar.
 */
const STALE_PART_MS = 12 * 3600_000;

/**
 * Städar bort temp-filer som en kraschad körning lämnat efter sig.
 *
 * Med en egen temp-fil per hämtning (se downloadModel) skrivs de inte längre
 * över av nästa försök, så en process som dör mitt i skulle annars lämna en
 * halv GGUF liggande för alltid. Filerna är ofarliga -- findModel() letar bara
 * efter .gguf -- men de tar gigabyte.
 */
function sweepStaleParts(dir: string, modelFile: string): void {
  try {
    const cutoff = Date.now() - STALE_PART_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${modelFile}.`) || !name.endsWith(".part")) {
        continue;
      }
      const full = path.join(dir, name);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
      }
    }
  } catch {
    // Städning är aldrig värd att fälla en hämtning på.
  }
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
  // INGEN HASH, INGEN HÄMTNING. En modell som hämtas över nätet och sedan
  // spawnas som barnprocess måste vara pinnad; en post utan sha256 får därför
  // inte gå att ladda ner alls, oavsett hur den kom hit.
  //
  // Grinden sitter här och inte hos anroparen med flit. COMPLETION_DOWNLOAD har
  // en tom hash och noll anropsställen idag (se kommentaren där), men den är
  // exporterad -- och den som kopplar in den om ett år ska mötas av ett tydligt
  // fel, inte av en tyst nedladdning som hoppar över kontrollen.
  if (!model.sha256) {
    throw new Error(
      `${model.label} has no pinned SHA-256, so it cannot be downloaded. ` +
        `It ships inside the installer instead.`
    );
  }

  const url = downloadUrlFor(model);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // ─────────────────────────────────────────────────────────────────────────
  // EGEN TEMP-FIL PER HÄMTNING, inte en delad `<dest>.part`.
  //
  // VARFÖR -- uppmätt med två samtidiga first-run-hämtningar till samma mål,
  // alltså två fönster som båda utlöser en instruct-funktion första gången:
  //
  //   fönster A -> false, "ENOENT: no such file or directory, open ...part"
  //   fönster B -> true
  //   resultat: filen blev korrekt (2 132 498 112 B)
  //
  // Slutfilen blev alltså rätt, men BARA för att båda laddade ner exakt samma
  // bytes till samma filhandtag. Vägen dit var full av fällor: B döpte om
  // .part-filen medan A fortfarande höll på, så A hashade en fil som inte fanns
  // längre. Åt andra hållet hade A:s städning (`rmSync(part)`) kunnat radera
  // filen B just höll på att skriva.
  //
  // Med ett eget namn per hämtning är fönstren oberoende: var och en laddar
  // ner, verifierar sin EGEN fil och döper om den till samma mål. Sist vinner,
  // och båda kandidaterna är verifierade. Priset är dubbel bandbredd i det
  // ovanliga fallet -- samma som förut -- men felvägen försvinner.
  // ─────────────────────────────────────────────────────────────────────────
  const part = `${dest}.${process.pid}-${Date.now().toString(36)}.part`;
  sweepStaleParts(path.dirname(dest), model.file);

  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());

  try {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal });
    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }

    let written = 0;
    let lastPercent = 0;

    // ─────────────────────────────────────────────────────────────────────
    // pipeline() OCH INTE EN EGEN write/drain-LOOP. Skälet är uppmätt.
    //
    // Den handskrivna loopen såg ut så här:
    //
    //   const out = fs.createWriteStream(part);
    //   for await (const chunk of res.body) {
    //     if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
    //   }
    //
    // Ingen felhanterare på strömmen. Ett skrivfel -- och det realistiska
    // felet här är att disken tar slut mitt i 2,1 GB -- gav då:
    //
    //   Error: EISDIR/ENOSPC ...
    //   Emitted 'error' event on WriteStream instance at: ...
    //
    // alltså ett OHANTERAT strömfel som inte gick genom vårt try/catch alls.
    // Värre: hade felet kommit medan vi väntade på "drain" hade väntan aldrig
    // lösts upp, och out.end() i finally hade inte heller anropat sin callback.
    // Nedladdningen hade HÄNGT med en progressruta som aldrig blev klar.
    //
    // pipeline() propagerar fel från båda hållen, river strömmarna, och
    // returnerar ett promise som faktiskt avvisas. Backpressure sköts åt oss,
    // så generatorn nedan bara räknar och rapporterar.
    // ─────────────────────────────────────────────────────────────────────
    await pipeline(
      async function* () {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          written += chunk.length;
          const percent = Math.floor((written / model.bytes) * 100);
          if (percent > lastPercent) {
            progress.report({
              increment: percent - lastPercent,
              message: `${(written / 1048576).toFixed(0)} MB of ${(model.bytes / 1048576).toFixed(0)} MB`,
            });
            lastPercent = percent;
          }
          yield chunk;
        }
      },
      fs.createWriteStream(part)
    );

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
    // STÄDNINGEN FÅR ALDRIG SKUGGA ORSAKEN. Kastar rmSync här -- .part är
    // låst av en annan process, ligger på en full disk, är en katalog -- så
    // ersätts det RIKTIGA felet av städfelet, och användaren får veta att en
    // borttagning misslyckades i stället för att disken är full.
    //
    // Uppmätt: med en katalog i vägen blev beskedet "Path is a directory: rm
    // returned EISDIR", vilket säger ingenting om vad som faktiskt gick fel.
    try {
      fs.rmSync(part, { force: true, recursive: true });
    } catch {
      // Halvfilen ligger kvar. Den heter .part och kan aldrig förväxlas med en
      // färdig modell -- findModel() letar bara efter .gguf -- och nästa försök
      // skriver över den. Originalfelet är viktigare.
    }
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
