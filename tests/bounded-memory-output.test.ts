import { afterEach, expect, test } from "bun:test";
import { isRecord } from "../src/type-guards.ts";
import { ALL_GATES_OFF, Harness } from "./helpers/system1-chat.ts";

const harness = new Harness();
afterEach(() => harness.close());
function delivered(original: string, override: unknown): string {
  if (override === undefined) return original;
  if (!isRecord(override) || !Array.isArray(override.content)) throw new Error("invalid tool result override");
  return override.content.map((part: unknown) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") throw new Error("invalid text result");
    return part.text;
  }).join("\n");
}

test("bounded memory results stay parseable and source-exact under a small ordinary tool cap", async () => {
  const { host } = await harness.open({ flags: { ...ALL_GATES_OFF, "no-optchat-decisions": false, "no-optchat-work-discovery": false, "optchat-tool-cap": "128" } });
  const user = host.user("Decision staging: blue");
  await host.context([user]);
  await host.fire("agent_end", { messages: [user], willContinue: false });
  for (const [toolName, input] of [["chat_work", {}], ["chat_decisions", { question: "staging" }]] as const) {
    const original = await host.callTool(toolName, input);
    expect(original.length).toBeGreaterThan(128);
    const [override] = await host.fire("tool_result", { toolName, toolCallId: toolName, content: [{ type: "text", text: original }], isError: false });
    const text = delivered(original, override);
    expect(text).toBe(original);
    if (toolName === "chat_work") expect(JSON.parse(text.slice(text.indexOf("\n") + 1)).captures).toEqual([]);
    else expect(text).toContain("Decision staging: blue");
  }
  const ordinary = "ordinary output ".repeat(100);
  const [override] = await host.fire("tool_result", { toolName: "read", toolCallId: "ordinary", content: [{ type: "text", text: ordinary }], isError: false });
  expect(delivered(ordinary, override).length).toBeLessThanOrEqual(128);
});
