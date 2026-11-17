import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackStoreDirectory, globalStoreDirectory } from "../src/config.ts";
import { createOptChat } from "../src/index.ts";
import { Store, StoreLeaseConflictError } from "../src/store.ts";
import { openFakeHost } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF } from "./helpers/system1-chat.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "optchat-startup-lease-")));
  cleanups.push(() => rm(path, { force: true, recursive: true }));
  return path;
}

async function hold(path: string): Promise<Store> {
  const store = await Store.open(path);
  cleanups.push(() => store.close());
  return store;
}

async function contender(path: string, flags = {}, settleTimeoutMs = 500) {
  const host = await openFakeHost(createOptChat({ settleTimeoutMs }), { directory: path, flags: { ...ALL_GATES_OFF, ...flags } });
  cleanups.push(() => host.close());
  return {
    host,
    preflight: () => host.fire("before_agent_start", { prompt: "fresh", systemPrompt: [] }),
  };
}

/** Control backoff without sleeping; the preflight wait itself still has a real deadline. */
function clock() {
  let now = 0;
  const spy = spyOn(performance, "now").mockImplementation(() => now);
  cleanups.push(() => spy.mockRestore());
  return (ms: number) => { now += ms; };
}

test("only eligible fresh prompts retry the final startup path, with capped backoff and one inactive entry", async () => {
  const advance = clock();
  const agent = await directory();
  const global = await hold(globalStoreDirectory(agent));
  const fallback = await hold(fallbackStoreDirectory(agent, agent));
  const { host, preflight } = await contender(agent, { "optchat-dir": undefined });
  await global.close();
  const open = spyOn(Store, "open");
  cleanups.push(() => open.mockRestore());

  for (const delay of [250, 500, 1_000, 2_000, 4_000, 4_000]) {
    open.mockClear();
    advance(delay - 1);
    await expect(preflight()).resolves.toEqual([undefined]);
    expect(open).not.toHaveBeenCalled();
    advance(1);
    await expect(host.context([host.user("background run")])).resolves.toBeUndefined();
    await expect(host.fire("before_provider_request", { payload: {} })).resolves.toEqual([undefined]);
    await expect(host.fire("session_before_compact")).resolves.toEqual([undefined]);
    expect(open).not.toHaveBeenCalled();
    await expect(preflight()).resolves.toEqual([undefined]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe(fallback.directory);
    expect(host.tools.size).toBe(0);
  }
  expect(host.entries).toHaveLength(1);
  expect(host.notices.filter((note) => note.type === "warning")).toHaveLength(1);
  await fallback.close();
  advance(4_000);
  await expect(preflight()).resolves.toEqual([expect.objectContaining({ systemPrompt: expect.any(Array) })]);
  expect(host.tools.has("zoom")).toBe(true);
  await expect(Store.open(fallback.directory)).rejects.toBeInstanceOf(StoreLeaseConflictError);
  const free = await hold(global.directory);
  expect(free.messages).toHaveLength(0);
});

test("a passive run does not activate on a preflight during a scheduled continuation", async () => {
  const advance = clock();
  const path = await directory();
  const holder = await hold(path);
  const { host, preflight } = await contender(path);
  await host.fire("agent_start");
  await host.fire("agent_end", { messages: [], willContinue: true });
  await holder.close();
  advance(250);
  const open = spyOn(Store, "open");
  cleanups.push(() => open.mockRestore());
  await expect(preflight()).resolves.toEqual([undefined]);
  expect(open).not.toHaveBeenCalled();
  await host.fire("agent_start");
  await host.fire("agent_end", { messages: [], willContinue: false });
  await expect(preflight()).resolves.toEqual([expect.objectContaining({ systemPrompt: expect.any(Array) })]);
  expect(open).toHaveBeenCalledTimes(1);
});

test("non-conflict failure discovered by retry fails closed and is not retried after repair", async () => {
  const advance = clock();
  const path = await directory();
  const holder = await hold(path);
  const { host, preflight } = await contender(path);
  const stray = join(path, "main", "stray.txt");
  await writeFile(stray, "not a store log\n");
  await holder.close();
  advance(250);
  await expect(preflight()).resolves.toEqual([undefined]);
  expect(host.notices.some((notice) => notice.type === "error" && notice.message.includes("Every prompt will be refused"))).toBe(true);
  expect(host.tools.size).toBe(0);
  await rm(stray);
  // A repaired directory opens for another writer, but this session stays failed.
  await (await hold(path)).close();
  advance(4_000);
  await preflight();
  await expect(host.context([host.user("do not send")])).resolves.toEqual({ messages: [] });
  expect(host.aborts).toBe(1);
  expect(host.tools.size).toBe(0);
});

for (const cancel of ["deadline", "shutdown"] as const) {
  test(`a retry cancelled by ${cancel} closes a late open without publishing memory`, async () => {
    const advance = clock();
    const path = await directory();
    const holder = await hold(path);
    const { host, preflight } = await contender(path, {}, 50);
    await holder.close();
    const acquired = await hold(path);
    const giveStore = Promise.withResolvers<Store>();
    const closed = Promise.withResolvers<void>();
    const close = acquired.close.bind(acquired);
    const closeSpy = spyOn(acquired, "close").mockImplementation(async () => {
      await close();
      closed.resolve();
    });
    const open = spyOn(Store, "open").mockImplementation(() => giveStore.promise);
    cleanups.push(() => { open.mockRestore(); closeSpy.mockRestore(); });
    advance(250);
    const pending = preflight();
    try {
      expect(open).toHaveBeenCalledTimes(1);
      if (cancel === "shutdown") await host.shutdown();
      await expect(pending).resolves.toEqual([undefined]);
      if (cancel === "deadline") {
        await expect(host.context([host.user("plain")])).resolves.toBeUndefined();
        await expect(preflight()).resolves.toEqual([undefined]);
        expect(open).toHaveBeenCalledTimes(1);
      }
    } finally {
      giveStore.resolve(acquired);
    }
    await closed.promise;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(host.tools.size).toBe(0);
    expect(host.notices.some((notice) => notice.message.startsWith("OptChat active:"))).toBe(false);
    open.mockRestore();
    await hold(path);
  });
}

test("a lease conflict while reopening after /optchat new does not arm startup recovery", async () => {
  const advance = clock();
  const path = join(await directory(), "chat");
  const { host, preflight } = await contender(path);
  host.ctx.isIdle = () => true;
  host.ctx.hasUI = false;
  const open = spyOn(Store, "open").mockRejectedValueOnce(new StoreLeaseConflictError("held after archive"));
  cleanups.push(() => open.mockRestore());
  const notices = await host.command("new");
  expect(notices.some((notice) => notice.type === "error" && notice.message.includes("no fresh chat opened"))).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
  advance(5_000);
  await expect(preflight()).resolves.toEqual([undefined]);
  expect(open).toHaveBeenCalledTimes(1);
});
