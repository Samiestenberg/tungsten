// Lokal hemlighets-skanning. Inga nätverksanrop, inga modeller -- bara
// mönstermatchning, så den kan köra på varje inklistring utan kostnad.
//
// Bygger vidare på SECRET_FILE_PATTERN i core/tools.ts (som read_file redan
// använder för att vägra läsa .env/.dev.vars/.pem) i stället för att
// duplicera den. Den används här för att avgöra VAR en hemlighet är rimlig:
// i en .env-fil hör den hemma, i källkod eller i en commit gör den inte det.
import { SECRET_FILE_PATTERN } from "./core/tools.js";

export { SECRET_FILE_PATTERN };

export interface SecretRule {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Mönster som är specifika nog att en träff betyder något. Generiska
 * "hittade ordet secret" är värdelösa -- de tränar bort folk från varningen.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "private-key",
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "aws-access-key-id",
    label: "AWS access key ID",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "aws-secret-access-key",
    label: "AWS_SECRET_ACCESS_KEY",
    pattern: /\bAWS_SECRET_ACCESS_KEY\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/g,
  },
  {
    id: "github-token",
    label: "GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  },
  {
    id: "slack-token",
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "anthropic-key",
    label: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai-key",
    label: "OpenAI key",
    // sk-ant- fångas av regeln ovan; negativ lookahead så den inte dubbelflaggas.
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "google-api-key",
    label: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "jwt",
    label: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "assigned-secret",
    label: "secret in assignment",
    // Namn som betyder hemlighet + ett värde som ser ut som ett riktigt värde.
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|private[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']([^"'\n]{12,})["']/gi,
  },
  {
    id: "env-assigned-secret",
    label: "secret in environment variable",
    // .env-stil utan citattecken: NAMN=värde till radslut.
    pattern:
      /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*[ \t]*=[ \t]*(?!["'\s]*$)([^\s"'#][^\n#]{11,})$/gm,
  },
];

/**
 * Värden som ser ut som hemligheter men inte är det. Utan de här flaggas varje
 * exempel-fil och varje `process.env`-referens, och då slutar folk läsa
 * varningen -- vilket är värre än att inte ha den.
 */
const PLACEHOLDER = new RegExp(
  [
    "process\\.env",
    "import\\.meta\\.env",
    "\\$\\{",              // ${VAR} / template literal
    "\\$[A-Z_]+",          // $VAR
    "^<.*>$",              // <din-nyckel>
    "your[_-]?(key|token|secret|password)",
    "\\b(example|sample|dummy|placeholder|changeme|change_me|redacted|removed|hidden|test)\\b",
    "^x{4,}$",
    "^\\*{4,}$",
    "^\\.{3,}$",
    "^(true|false|null|undefined|none|empty)$",
  ].join("|"),
  "i"
);

export interface SecretFinding {
  readonly ruleId: string;
  readonly label: string;
  /** Teckenindex i den skannade texten. */
  readonly index: number;
  readonly length: number;
  /** Maskerad förhandsvisning. Vi loggar eller visar ALDRIG hela hemligheten. */
  readonly preview: string;
}

/** Visar början och slutet, aldrig mitten. */
export function mask(secret: string): string {
  const s = secret.trim();
  if (s.length <= 8) {
    return "*".repeat(s.length);
  }
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

/**
 * Skannar text. Returnerar en träff per hemlighet, sorterad på position.
 * Rena regexanrop -- ingen I/O, ingen modell.
 */
export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const rule of SECRET_RULES) {
    // Egen regex per anrop: lastIndex på en global regex är delat tillstånd
    // och skulle läcka mellan skanningar.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Undvik oändlig loop på nollängdsmatchning.
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      // Grupp 1 är värdet när regeln har en; annars hela matchningen.
      const value = m[1] ?? m[0];
      if (PLACEHOLDER.test(value)) {
        continue;
      }
      findings.push({
        ruleId: rule.id,
        label: rule.label,
        index: m.index,
        length: m[0].length,
        preview: mask(value),
      });
    }
  }

  // Samma hemlighet kan träffa flera regler -- AWS_SECRET_ACCESS_KEY=... matchar
  // både den specifika AWS-regeln och den generella miljövariabel-regeln. Räkna
  // den en gång: vid överlapp vinner regeln som står först i SECRET_RULES,
  // alltså den mer specifika.
  findings.sort((a, b) => a.index - b.index || b.length - a.length);
  const deduped: SecretFinding[] = [];
  for (const f of findings) {
    const overlaps = deduped.some(
      (kept) => f.index < kept.index + kept.length && kept.index < f.index + f.length
    );
    if (!overlaps) {
      deduped.push(f);
    }
  }
  return deduped;
}

/** En rad att visa i en varning: "2 möjliga hemligheter (GitHub-token, JWT)". */
export function describeFindings(findings: readonly SecretFinding[]): string {
  const labels = [...new Set(findings.map((f) => f.label))];
  const what =
    findings.length === 1 ? "1 possible secret" : `${findings.length} possible secrets`;
  return `${what} (${labels.join(", ")})`;
}

/**
 * Är hemligheter förväntade i den här filen? En .env ÄR platsen för nycklar,
 * så en varning där är brus. Samma mönster som read_file använder.
 */
export function isSecretFile(fsPath: string): boolean {
  return SECRET_FILE_PATTERN.test(fsPath);
}
