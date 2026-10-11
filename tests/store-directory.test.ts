import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { defaultStoreDirectory, readConfig } from "../src/config.ts";
import { Store, StoreLeaseConflictError } from "../src/store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A temporary tree: `agent` is the OMP agent directory and `repo` a main checkout whose `.git` is a directory. */
async function tree(): Promise<{ root: string; agent: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "optchat-dir-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "src", "deep"), { recursive: true });
  return { root, agent: join(root, "agent"), repo };
}

/** A linked worktree: a directory whose `.git` is a file, as `git worktree add` creates. */
async function linkedWorktree(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, ".git"), `gitdir: ${join(path, "..", "repo", ".git", "worktrees", basename(path))}\n`);
  return path;
}

function flagReader(flags: Record<string, string | boolean | undefined>): Pick<ExtensionAPI, "getFlag"> {
  return { getFlag: (name: string) => flags[name] } as unknown as Pick<ExtensionAPI, "getFlag">;
}

describe("defaultStoreDirectory", () => {
  test("linked worktrees of one repository, even with the same basename, get different directories", async () => {
    const { root, agent } = await tree();
    const first = await linkedWorktree(join(root, "one", "app"));
    const second = await linkedWorktree(join(root, "two", "app"));
    const firstDirectory = defaultStoreDirectory(agent, first);
    const secondDirectory = defaultStoreDirectory(agent, second);
    expect(firstDirectory).not.toBe(secondDirectory);
    expect(dirname(firstDirectory)).toBe(join(agent, "optchat-worktrees"));
    expect(dirname(secondDirectory)).toBe(join(agent, "optchat-worktrees"));
  });

  test("a nested subdirectory resolves to the directory of its worktree root", async () => {
    const { agent, repo } = await tree();
    expect(defaultStoreDirectory(agent, join(repo, "src", "deep"))).toBe(defaultStoreDirectory(agent, repo));
  });

  test("a symlink to the same root resolves to the same directory", async () => {
    const { root, agent, repo } = await tree();
    const link = join(root, "link-to-repo");
    await symlink(repo, link);
    expect(defaultStoreDirectory(agent, link)).toBe(defaultStoreDirectory(agent, repo));
  });

  test("a directory with a .git file is a worktree root, including its nested directories", async () => {
    const { root, agent } = await tree();
    const worktree = await linkedWorktree(join(root, "wt"));
    await mkdir(join(worktree, "nested"));
    const directory = defaultStoreDirectory(agent, join(worktree, "nested"));
    expect(directory).toBe(defaultStoreDirectory(agent, worktree));
    expect(dirname(directory)).toBe(join(agent, "optchat-worktrees"));
  });

  test("a cwd outside any git checkout uses the global store", async () => {
    const { root, agent } = await tree();
    const plain = join(root, "plain", "nested");
    await mkdir(plain, { recursive: true });
    expect(defaultStoreDirectory(agent, plain)).toBe(join(agent, "optchat"));
  });

  test("the directory name is the sanitized, bounded basename plus the first 16 hex digits of the root's SHA-256", async () => {
    const { root, agent } = await tree();
    const named = join(root, "My Very Long Repository Name, With Spaces And Ünïcode 2026 extra words");
    await linkedWorktree(named);
    const directory = defaultStoreDirectory(agent, named);
    const name = basename(directory);
    const digest = createHash("sha256").update(await realpath(named)).digest("hex").slice(0, 16);
    const slug = name.slice(0, name.length - digest.length - 1);
    expect(name.endsWith(`-${digest}`)).toBe(true);
    expect(slug).toMatch(/^[a-z0-9._-]{1,40}$/);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.startsWith("my-very-long-repository-name")).toBe(true);
  });
});

describe("readConfig with the resolved default", () => {
  test("an absent --optchat-dir uses the worktree default", async () => {
    const { root, agent } = await tree();
    const worktree = await linkedWorktree(join(root, "wt"));
    const fallback = defaultStoreDirectory(agent, worktree);
    expect(readConfig(flagReader({}), fallback).directory).toBe(fallback);
  });

  test("--optchat-dir overrides the worktree default", async () => {
    const { root, agent } = await tree();
    const worktree = await linkedWorktree(join(root, "wt"));
    const explicit = join(root, "shared-memory");
    expect(readConfig(flagReader({ "optchat-dir": explicit }), defaultStoreDirectory(agent, worktree)).directory).toBe(explicit);
  });
});

describe("lease conflicts", () => {
  test("a second writer on a held directory fails with the typed lease conflict; releasing restores the lease", async () => {
    const { root } = await tree();
    const directory = join(root, "memory");
    const holder = await Store.open(directory);
    try {
      const error = await Store.open(directory).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(StoreLeaseConflictError);
      expect((error as Error).message).toBe("Store is already open by another writer");
    } finally {
      await holder.close();
    }
    const reopened = await Store.open(directory);
    await reopened.close();
  });

  test("a corrupt store is not a lease conflict", async () => {
    const { root } = await tree();
    const directory = join(root, "memory");
    await mkdir(join(directory, "main"), { recursive: true });
    await writeFile(join(directory, "main", "stray.txt"), "not a daily log\n");
    const error = await Store.open(directory).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StoreLeaseConflictError);
  });
});
