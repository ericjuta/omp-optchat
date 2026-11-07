import { expect, spyOn, test } from "bun:test";
import { createOptChat } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { isRecord } from "../src/type-guards.ts";
import { openFakeHost, type FakeHost } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF } from "./helpers/system1-chat.ts";

async function context(host: FakeHost, messages: unknown[]): Promise<unknown[]> {
  for (const result of await host.fire("context", { messages })) {
    if (isRecord(result) && Array.isArray(result.messages)) messages = result.messages;
  }
  return messages;
}

test("parent log failure removes a persisted child pack before the next continuation", async () => {
  const manager = {};
  const flags = { ...ALL_GATES_OFF, "no-optchat-child-pack": undefined };
  const parent = await openFakeHost(createOptChat(), { artifactManager: manager, flags });
  let child: FakeHost | undefined;
  try {
    const original = parent.user("Orchid deployment uses port 4417.");
    await parent.context([original]);
    await parent.fire("agent_end", { messages: [original], willContinue: false });
    child = await openFakeHost(createOptChat(), { artifactManager: manager, agentKind: "sub", flags });
    const [start] = await child.fire("before_agent_start", { systemPrompt: [], prompt: "Find the Orchid deployment port." });
    if (!isRecord(start) || !isRecord(start.message)) throw new Error("child pack was not issued");
    const pack = { ...start.message, role: "custom", timestamp: 1 };
    const ordinary = { role: "user", content: "Continue the task.", timestamp: 2 };
    expect(await context(child, [pack, ordinary])).toEqual([pack, ordinary]);

    const turn = parent.user("Begin the failure turn.");
    await parent.context([original, turn]);
    const append = Store.prototype.append;
    const fault = spyOn(Store.prototype, "append").mockImplementation(function (this: Store, ...args: Parameters<Store["append"]>) {
      if (this.directory === parent.directory) throw new Error("synthetic parent-log failure");
      return append.apply(this, args);
    });
    try {
      const trigger = parent.user("Trigger the storage fault.");
      await parent.fire("message_end", { message: trigger });
      await parent.fire("agent_end", { messages: [original, turn, trigger], willContinue: false });
      expect(parent.notices.some((notice) => notice.message.includes("synthetic parent-log failure"))).toBe(true);
      // No new task/before_agent_start: this is replay of an already persisted pack.
      expect(await context(child, [pack, ordinary])).toEqual([ordinary]);
    } finally {
      fault.mockRestore();
    }
  } finally {
    await child?.close();
    await parent.close();
  }
});
