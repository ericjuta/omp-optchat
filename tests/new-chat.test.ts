/**
 * `/optchat new`, the explicit reset. The old store moves to a sibling archive whose files keep their bytes, and a
 * fresh, empty store opens at the original path through the normal open path. Runs the real OptChat hooks on the fake host.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createOptChat } from "../src/index.ts";
import { LEDGER_FILE } from "../src/system1/ledger.ts";
import { startCompressorServer, type CompressorServer } from "./helpers/compressor-server.ts";
import { openFakeHost, type FakeHost, type HostMessage, type Notice } from "./helpers/fake-host.ts";
import {
  anthropicModel,
  hasNotice,
  messagesOf,
  RULE_ADDED,
  RULE_TEXT,
  routedJudge,
  SEED_TEXTS,
  SMALL_NODES,
  until,
} from "./helpers/system1-chat.ts";

/** A 1x1 PNG: a real image, so the store saves it under images/. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const roots: string[] = [];
const hosts: FakeHost[] = [];
const servers: CompressorServer[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A fresh workspace. The store sits at `<root>/chat`, so its archives are siblings named `chat.<stamp>`. */
async function workspace(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "optchat-new-"));
  roots.push(root);
  return { root, directory: join(root, "chat") };
}

/**
 * A chat host. Like the real host, a second registration of a tool name throws, so a reopened chat must not
 * register its tools again.
 */
async function openChat(directory: string, options: { confirm?: boolean; hasUI?: boolean } = {}): Promise<FakeHost> {
  const compressor = await startCompressorServer();
  servers.push(compressor);
  const judge = routedJudge({ ruleWhen: "always reply in French" });
  const extension = createOptChat({ judge: () => judge });
  const host = await openFakeHost(
    (pi: ExtensionAPI) => {
      const registered: string[] = [];
      extension(
        new Proxy(pi, {
          get(target, key) {
            if (key === "registerTool") {
              return (tool: { name: string }) => {
                if (registered.includes(tool.name)) throw new Error(`tool name "${tool.name}" is already registered`);
                registered.push(tool.name);
                return Reflect.apply(target.registerTool, target, [tool]);
              };
            }
            if (key === "getAllTools") return () => [...target.getAllTools(), ...registered.map((name) => ({ name }))];
            return Reflect.get(target, key);
          },
        }),
      );
    },
    {
      directory,
      flags: { ...SMALL_NODES },
      model: compressor.model,
      mainModel: anthropicModel(),
      apiKey: "fixture-key",
      hasUI: options.hasUI ?? true,
      confirm: () => options.confirm ?? true,
    },
  );
  hosts.push(host);
  return host;
}

/** One complete turn, as the host runs it: the context hook sees the transcript, then the run ends. */
async function turn(host: FakeHost, transcript: readonly HostMessage[], message: HostMessage): Promise<HostMessage[]> {
  const messages = [...transcript, message];
  await host.context(messages);
  const done = [...messages, host.assistant("noted")];
  await host.fire("agent_end", { messages: done, willContinue: false });
  return done;
}

async function statusOf(host: FakeHost): Promise<string> {
  return (await host.command("status")).at(-1)?.message ?? "";
}

/** Waits until no compressor job runs: the files on disk are then the chat's settled bytes. */
async function settled(host: FakeHost): Promise<void> {
  await until(async () => (await statusOf(host)).includes("compressor jobs running: 0"), "the compressor to settle");
}

function messageCount(status: string): number {
  const match = /messages: (\d+);/.exec(status);
  if (!match) throw new Error(`no message count in: ${status}`);
  return Number(match[1]);
}

/** Seeds a chat with a stated rule, eight short messages that compact into the tree, and a picture; then settles it. */
async function seed(host: FakeHost): Promise<HostMessage[]> {
  let transcript: HostMessage[] = [];
  for (const text of [RULE_TEXT, ...SEED_TEXTS]) transcript = await turn(host, transcript, host.user(text));
  const picture = {
    ...host.user("the table"),
    content: [
      { type: "text", text: "the table" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
  } as HostMessage;
  transcript = await turn(host, transcript, picture);
  await until(() => hasNotice(host, RULE_ADDED), "the rule to be added");
  await settled(host);
  return transcript;
}

/** `/optchat new` as the command runs between turns: the agent reports idle for this call only. */
async function runNew(host: FakeHost): Promise<Notice[]> {
  // Unchecked: the fake host's ctx is a plain object, and the test swaps its isIdle for one call.
  const ctx = host.ctx as unknown as { isIdle: () => boolean };
  const isIdle = ctx.isIdle;
  ctx.isIdle = () => true;
  try {
    return await host.command("new");
  } finally {
    ctx.isIdle = isIdle;
  }
}

/** Every entry under `directory`: a digest per file and `directory` per folder. Equal maps mean equal bytes and layout. */
async function snapshot(directory: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (path: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        entries.set(`${name}/`, "directory");
        await walk(join(path, entry.name), `${name}/`);
      } else {
        entries.set(name, createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex"));
      }
    }
  };
  await walk(directory, "");
  return entries;
}

/** The archives of the store at `<root>/chat`: siblings named `chat.<stamp>`. */
async function archivesOf(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith("chat.")).map((name) => join(root, name));
}

describe("/optchat new", () => {
  test("archives the old store byte for byte and opens an empty one at the same path", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory);
    await seed(host);
    const before = await snapshot(directory);
    const names = [...before.keys()];
    expect(names).toEqual(expect.arrayContaining(["view.json", LEDGER_FILE]));
    expect(names.some((name) => name.startsWith("main/"))).toBe(true);
    expect(names.some((name) => name.startsWith("tree/"))).toBe(true);
    expect(names.some((name) => name.startsWith("images/"))).toBe(true);

    const notices = await runNew(host);
    const archives = await archivesOf(root);
    expect(archives).toHaveLength(1);
    const [archive] = archives;
    expect(host.confirms).toHaveLength(1);
    expect(host.confirms[0]!.message).toContain(archive!);
    expect(notices.at(-1)).toEqual({
      message: `OptChat started a new chat. The previous chat is archived at ${archive}; reopen it with --optchat-dir ${archive}.`,
      type: "info",
    });

    expect(await snapshot(archive!)).toEqual(before);
    // Nothing of the old chat is left: the only file is the empty view snapshot every opened store commits.
    const fresh = await snapshot(directory);
    expect([...fresh.keys()].filter((key) => !key.endsWith("/"))).toEqual(["view.json"]);
    expect(await statusOf(host)).toContain("messages: 0;");
  });

  test("the fresh chat sees none of the old chat, its tools still work, and its first turn logs message 0", async () => {
    const { directory } = await workspace();
    const host = await openChat(directory);
    const transcript = await seed(host);
    await runNew(host);

    const messages = [...transcript, host.user("hello again")];
    const seen = JSON.stringify(messagesOf(await host.context(messages)));
    expect(seen).toContain("hello again");
    expect(seen).not.toContain("morning coffee for two");
    await host.fire("agent_end", { messages: [...messages, host.assistant("noted")], willContinue: false });
    await settled(host);

    expect(messageCount(await statusOf(host))).toBe(2);
    expect(await host.callTool("zoom", { id: 0, n: 1 })).toContain("hello again");
  });

  test("standing rules of the old chat are gone from the fresh chat", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory);
    const transcript = await seed(host);
    expect((await host.command("rules")).at(-1)?.message).toContain(RULE_TEXT);

    await runNew(host);
    expect((await host.command("rules")).at(-1)?.message).toBe("OptChat has no standing rules.");
    const [archive] = await archivesOf(root);
    expect(await readFile(join(archive!, LEDGER_FILE), "utf8")).toContain(RULE_TEXT);
    const seen = JSON.stringify(messagesOf(await host.context([...transcript, host.user("what time is it")])));
    expect(seen).not.toContain(RULE_TEXT);
  });

  test("refused while the agent is busy: nothing is archived and the chat is unchanged", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory);
    await seed(host);
    const before = await snapshot(directory);
    const status = await statusOf(host);

    // The fake host reports a busy agent unless a test says otherwise.
    const notices = await host.command("new");
    expect(notices.at(-1)).toEqual({ message: "/optchat new: wait until the agent is idle before starting a new chat", type: "error" });
    expect(host.confirms).toHaveLength(0);
    expect(await archivesOf(root)).toEqual([]);
    expect(await snapshot(directory)).toEqual(before);
    expect(await statusOf(host)).toBe(status);
  });

  test("refused while this session holds no memory: another session owns the store", async () => {
    const { root, directory } = await workspace();
    const owner = await openChat(directory);
    await seed(owner);
    const before = await snapshot(directory);
    const status = await statusOf(owner);

    const other = await openChat(directory);
    expect(hasNotice(other, "OptChat is inactive")).toBe(true);
    const notices = await runNew(other);
    expect(notices.at(-1)?.type).toBe("error");
    expect(notices.at(-1)?.message).toContain("holds no open memory");
    expect(await archivesOf(root)).toEqual([]);
    expect(await snapshot(directory)).toEqual(before);
    expect(await statusOf(owner)).toBe(status);
  });

  test("a declined confirmation changes nothing, and the chat keeps working", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory, { confirm: false });
    const transcript = await seed(host);
    const before = await snapshot(directory);
    const count = messageCount(await statusOf(host));

    const notices = await runNew(host);
    expect(host.confirms).toHaveLength(1);
    expect(notices.at(-1)).toEqual({ message: "OptChat new chat cancelled: nothing changed.", type: "info" });
    expect(await archivesOf(root)).toEqual([]);
    expect(await snapshot(directory)).toEqual(before);

    await turn(host, transcript, host.user("still here"));
    await settled(host);
    expect(messageCount(await statusOf(host))).toBe(count + 2);
  });

  test("without a UI the explicit command proceeds without asking", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory, { hasUI: false });
    await seed(host);

    const notices = await runNew(host);
    expect(host.confirms).toHaveLength(0);
    expect(notices.at(-1)?.type).toBe("info");
    expect(await archivesOf(root)).toHaveLength(1);
    expect(messageCount(await statusOf(host))).toBe(0);
  });

  test.skipIf(process.getuid?.() === 0)("an archive failure reopens the original store, which keeps working", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory);
    const transcript = await seed(host);
    const count = messageCount(await statusOf(host));

    // No entry can be added to the root, so the archive cannot be claimed; the store itself stays writable.
    await chmod(root, 0o500);
    try {
      const notices = await runNew(host);
      expect(notices.at(-1)?.type).toBe("error");
      expect(notices.at(-1)?.message).toContain("could not archive the chat");
      expect(notices.at(-1)?.message).toContain("open again");
    } finally {
      await chmod(root, 0o700);
    }
    expect(await archivesOf(root)).toEqual([]);

    await turn(host, transcript, host.user("after the failure"));
    await settled(host);
    expect(messageCount(await statusOf(host))).toBe(count + 2);
  });

  test("a crash between the rename and the reopen leaves the archive intact; the next start creates a fresh store", async () => {
    const { root, directory } = await workspace();
    const host = await openChat(directory);
    await seed(host);
    await host.shutdown();
    const before = await snapshot(directory);

    // The process dies right after the rename: only the directory entry has moved.
    const archive = join(root, "chat.20261013T081500Z");
    await rename(directory, archive);

    const next = await openChat(directory);
    expect(messageCount(await statusOf(next))).toBe(0);
    expect(await snapshot(archive)).toEqual(before);
  });
});
