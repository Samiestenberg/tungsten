// Vilka FILER som kan innehålla hemligheter. En definition, två användare.
//
// VARFÖR EN EGEN FIL FÖR EN REGEX. Mönstret bodde tidigare i core/tools.ts
// (agentens read_file vägrar läsa sådana filer) och importerades därifrån av
// hemlighets-skannern i secrets.ts. Det var rätt tanke -- en definition i
// stället för två som glider isär -- men fel plats, och privacy-testet fångade
// varför:
//
//   secrets.ts är AKTIV kod. core/tools.ts är VILANDE agentkod som drar in
//   filsystemsskrivningar och run_command. Importen gjorde alltså att hela den
//   vilande verktygsimplementationen låg kvar i den aktiva modulgrafen, trots
//   att ingenting anropade den.
//
// Att bara kopiera regexen hade löst grafen och skapat ett värre problem: två
// definitioner av "den här filen kan innehålla en hemlighet", som med säkerhet
// hade glidit isär. Den här filen har inga beroenden alls, så båda sidor kan
// importera den utan att dra med sig något.

/**
 * .env och dess varianter, Cloudflares .dev.vars, och privata nycklar.
 *
 * Avsiktligt smal: den ska fånga filer som ÄR hemligheter, inte filer som kan
 * råka innehålla en. Innehållsskanningen i secrets.ts är den bredare grinden.
 */
export const SECRET_FILE_PATTERN =
	/(^|[\\/])(\.env(\.|$)|\.dev\.vars$|[^\\/]+\.pem$)/i;
