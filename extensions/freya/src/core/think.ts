// qwen3/kimi läcker ibland sitt resonemang som <think>...</think> rakt i
// delta.content i stället för i delta.reasoning_content. Det ska aldrig visas
// i chatten.
//
// Strömmande text kan dela en tagg mitt itu ("<thi" + "nk>"), så filtret måste
// hålla tillbaka en svans som *kan* vara början på en tagg tills nästa chunk
// avgör saken. Därför en liten tillståndsmaskin i stället för en regex.

const OPEN = "<think>";
const CLOSE = "</think>";

// Längsta svansen av s som är ett prefix av tag (utan att vara hela taggen).
function partialTailLength(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

export interface ThinkStripper {
  // Matar in en chunk och får tillbaka den text som är säker att visa.
  push(chunk: string): string;
  // Anropas när strömmen är slut: släpper ut kvarhållen text som visade sig
  // inte vara en tagg.
  flush(): string;
}

export function createThinkStripper(): ThinkStripper {
  let pending = "";
  let inThink = false;

  return {
    push(chunk: string): string {
      pending += chunk;
      let out = "";

      while (pending.length > 0) {
        if (inThink) {
          const end = pending.indexOf(CLOSE);
          if (end < 0) {
            // Kasta resonemanget, behåll bara det som kan vara "</think"
            pending = pending.slice(
              pending.length - partialTailLength(pending, CLOSE)
            );
            break;
          }
          pending = pending.slice(end + CLOSE.length);
          inThink = false;
          continue;
        }

        const start = pending.indexOf(OPEN);
        if (start < 0) {
          const keep = partialTailLength(pending, OPEN);
          out += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
          break;
        }
        out += pending.slice(0, start);
        pending = pending.slice(start + OPEN.length);
        inThink = true;
      }

      return out;
    },

    flush(): string {
      if (inThink) {
        // Oavslutad <think> — allt som återstår är resonemang, visa inget.
        pending = "";
        return "";
      }
      const rest = pending;
      pending = "";
      return rest;
    },
  };
}

// Engångsvariant för färdig text (icke-strömmande svar).
export function stripThinkTags(text: string): string {
  const s = createThinkStripper();
  return (s.push(text) + s.flush()).trim();
}
