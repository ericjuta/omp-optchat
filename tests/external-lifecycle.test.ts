import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOptChat } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { ProjectEvidence } from "../src/project-evidence.ts";
import { openFakeHost, type FakeHost } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF } from "./helpers/system1-chat.ts";

const roots: string[] = [];
const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<FakeHost> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "external-lifecycle-")));
  roots.push(root);
  const directory = join(root, "external");
  const source = await Store.open(directory);
  try { for (let i = 0; i < 24; i++) source.append("note", `orchid source ${i} ${"archive ".repeat(400)}`); }
  finally { await source.close(); }
  const host = await openFakeHost(createOptChat(), {
    directory: join(root, "main"), hasUI: false,
    flags: { ...ALL_GATES_OFF, "optchat-project-stores": JSON.stringify({ selected: directory }) },
  });
  host.ctx.isIdle = () => true;
  hosts.push(host);
  return host;
}
const search = (host: FakeHost) => host.callTool("chat_project_evidence", { mode: "search", question: "orchid" });

test.skipIf(process.platform !== "linux")("new-chat teardown closes external admission before its first drain await", async () => {
  const host = await fixture();
  const old = await search(host);
  const key = /store (selected@[a-f0-9]{64})/.exec(old)?.[1];
  expect(key).toBeDefined();
  const resetting = host.command("new");
  await expect(search(host)).rejects.toThrow();
  await resetting;
  await expect(host.callTool("chat_project_evidence", { mode: "read", store: key, id: 0 })).rejects.toThrow();
  const fresh = await search(host);
  expect(fresh).toContain("orchid source");
  expect(fresh).not.toContain(key!);
});

test.skipIf(process.platform !== "linux")("a parent log failure revokes an already yielding external query", async () => {
  const host = await fixture();
  const turnUser = host.user("Begin the controlled failure turn.");
  await host.context([turnUser]);
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const originalSearch = ProjectEvidence.prototype.search;
  const pause = spyOn(ProjectEvidence.prototype, "search").mockImplementation(async function (this: ProjectEvidence, question: string, names?: readonly string[], signal?: AbortSignal) {
    started.resolve();
    await proceed.promise;
    return originalSearch.call(this, question, names, signal);
  });
  const append = Store.prototype.append;
  const fault = spyOn(Store.prototype, "append").mockImplementation(function (this: Store, ...args: Parameters<Store["append"]>) {
    if (this.directory === host.directory) throw new Error("synthetic durable-log failure");
    return append.apply(this, args);
  });
  try {
    const querying = search(host);
    // Bun's rejection matcher may synchronously settle its promise; attach a normal handler while paused.
    const outcome = querying.then(() => "resolved" as const, () => "rejected" as const);
    const entered = await Promise.race([started.promise.then(() => true), outcome.then(() => false)]);
    expect(entered).toBe(true);
    const trigger = host.user("trigger the controlled storage fault");
    await host.fire("message_end", { message: trigger });
    await host.fire("agent_end", { messages: [turnUser, trigger], willContinue: false });
    expect(host.notices.some((notice) => notice.message.includes("synthetic durable-log failure"))).toBe(true);
    proceed.resolve();
    expect(await outcome).toBe("rejected");
    await expect(search(host)).rejects.toThrow();
  } finally {
    proceed.resolve();
    fault.mockRestore();
    pause.mockRestore();
  }
});
