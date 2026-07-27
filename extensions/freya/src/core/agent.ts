import { TOOL_SCHEMAS, executeTool } from "./tools.js";
import type { ConfirmFn } from "./tools.js";
import type { ModelProvider } from "./providers/types.js";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; input: any }
  | { type: "result"; name: string; output: string }
  | { type: "done" };

export interface RunOptions {
  provider: ModelProvider;
  prompt: string;
  workdir: string;
  confirm?: ConfirmFn;
  onEvent?: (e: AgentEvent) => void;
  history?: any[];
  maxSteps?: number;
}

export async function runAgent(opts: RunOptions) {
  const { provider, prompt, workdir, confirm, onEvent } = opts;
  const maxSteps = opts.maxSteps ?? 25;
  const emit = onEvent ?? (() => {});
  const messages: any[] = [
    ...(opts.history ?? []),
    { role: "user", content: prompt },
  ];

  for (let step = 0; step < maxSteps; step++) {
    let streamed = false;
    let streamedText = "";
    const res = await provider.send(messages, TOOL_SCHEMAS, (chunk) => {
      streamed = true;
      streamedText += chunk;
      emit({ type: "delta", text: chunk });
    });
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
        // providers utan streaming-stöd anropar aldrig deltat ovan — då
        // faller vi tillbaka på ett enda text-event, som tidigare.
        if (block.type === "text" && block.text?.trim() && !streamed) {
          emit({ type: "text", text: block.text });
        }
      }

      const toolUses = res.content.filter((b: any) => b.type === "tool_use");
      if (toolUses.length === 0) {
        // En tur utan både text och verktygsanrop avslutade körningen i total
        // tystnad -- panelen blev tom och det gick inte att skilja från en
        // krasch. qwen3 hamnar här när hela det synliga svaret var
        // <think>...</think> och strippern tog bort allt. Säg det i stället.
        const saidSomething =
          streamedText.trim() !== "" ||
          res.content.some(
            (b: any) => b.type === "text" && b.text?.trim()
          );
        if (!saidSomething) {
          emit({
            type: "text",
            text: "The model returned an empty answer. Try again, or rephrase the question.",
          });
        }
        emit({ type: "done" });
        return messages;
      }

    const results: any[] = [];
    for (const tu of toolUses) {
        emit({ type: "tool", name: tu.name, input: tu.input });
        const out = await executeTool(tu.name, tu.input, workdir, confirm);
        emit({ type: "result", name: tu.name, output: out });
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: out,
      });
    }
    messages.push({ role: "user", content: results });
  }

  emit({ type: "done" });
  return messages;
}