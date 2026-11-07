import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { digest } from "./real-budget.ts";

export const ARTIFACT_BYTES = 8 * 1024 * 1024;
export const INPUT_BYTES = 512 * 1024 * 1024;
export const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
};
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`Invalid ${label}`);
  return value;
}
export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
export function sha(value: unknown, label: string): string {
  const hash = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid ${label}`);
  return hash;
}
export function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export function childPath(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid frozen relative path");
  }
  return join(root, name);
}
/** Never follows a symlink or acquires a Store writer lease. A hash mismatch fails closed. */
export function readBytes(path: string, limit = INPUT_BYTES, expectedSha256?: string): Buffer {
  const absolute = resolve(path);
  let component: string = sep;
  for (const name of absolute.split(sep).filter(Boolean)) {
    component = join(component, name);
    if (lstatSync(component).isSymbolicLink()) throw new Error("Symlink in frozen input path");
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.uid !== process.getuid?.()) throw new Error("Input is not a bounded owned regular file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Input changed during read");
    if (expectedSha256 !== undefined && digest(bytes) !== expectedSha256) throw new Error("Frozen input SHA-256 mismatch");
    return bytes;
  } finally { closeSync(fd); }
}
export function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function jsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > ARTIFACT_BYTES) throw new Error("Artifact exceeds 8 MiB; refused, never silently truncated");
  return bytes;
}

/** A new private directory only; every artifact is exclusive-create and fsynced. */
export class PrivateRun {
  readonly root: string;
  readonly files: { path: string; bytes: number; sha256: string }[] = [];
  private readonly resultsFd: number;
  private readonly budgetFd: number;
  private sealed = false;
  constructor(path: string, forbiddenRoots: readonly string[]) {
    const parent = realpathSync(dirname(resolve(path)));
    this.root = join(parent, relative(dirname(resolve(path)), resolve(path)));
    if (forbiddenRoots.some((root) => within(root, this.root) || within(this.root, root))) throw new Error("Output overlaps immutable inputs");
    mkdirSync(this.root, { mode: 0o700 }); // EEXIST is intentional: no resume/overwrite.
    this.resultsFd = openSync(join(this.root, "results.jsonl"), "wx", 0o600);
    try { this.budgetFd = openSync(join(this.root, "budget.jsonl"), "wx", 0o600); }
    catch (error) { closeSync(this.resultsFd); throw error; }
  }
  save(name: string, value: unknown) {
    if (this.sealed) throw new Error("Run is sealed");
    const bytes = jsonBytes(value);
    const fd = openSync(childPath(this.root, name), "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const info = { path: name, bytes: bytes.length, sha256: digest(bytes) };
    this.files.push(info);
    return info;
  }
  append(kind: "results" | "budget", value: object): void {
    if (this.sealed) throw new Error("Run is sealed");
    const fd = kind === "results" ? this.resultsFd : this.budgetFd;
    const bytes = jsonBytes(value);
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error("Private journal write stalled");
      written += count;
    }
    fsyncSync(fd);
  }
  seal(summary: object): void {
    if (this.sealed) return;
    try {
      fsyncSync(this.resultsFd);
      fsyncSync(this.budgetFd);
      for (const name of ["results.jsonl", "budget.jsonl"]) {
        const bytes = readBytes(join(this.root, name), 128 * 1024 * 1024);
        this.files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
      }
      this.save("run.json", summary);
      this.save("files.json", { schemaVersion: 1, files: [...this.files] });
    } finally {
      this.sealed = true;
      closeSync(this.resultsFd);
      closeSync(this.budgetFd);
    }
  }
}
