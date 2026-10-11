import { Buffer } from "node:buffer";
import { closeSync, constants, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { utf8Prefix, utf8Bytes } from "../memory.js";

/** File name beside the chat log in the store directory. */
export const LEDGER_FILE = "ledger.jsonl";
/** Rule text kept verbatim up to this many UTF-8 bytes; longer text is cut and points at its source message. */
export const RULE_TEXT_BYTES = 512;

/** One standing rule. `id` is never reused; `source` is the message that stated it. */
export interface Rule {
  readonly id: string;
  readonly text: string;
  readonly source: number;
  readonly at: number;
}

type Event =
  | { readonly op: "add"; readonly id: string; readonly text: string; readonly source: number; readonly at: number }
  | { readonly op: "replace"; readonly id: string; readonly replaces: string; readonly text: string; readonly source: number; readonly at: number }
  | { readonly op: "remove"; readonly id: string; readonly at: number };

const ID = /^r[1-9][0-9]*$/;

/** Flatten to one line, then cut at a UTF-8 boundary with a pointer to the rest of the source message. */
export function clipRule(text: string, source: number): string {
  const line = text.replace(/\r\n|\r|\n/g, " ").trim();
  if (utf8Bytes(line) <= RULE_TEXT_BYTES) return line;
  return `${utf8Prefix(line, RULE_TEXT_BYTES)} … (zoom ${source} for the rest)`;
}

function eventOf(value: unknown): Event | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !ID.test(row.id) || typeof row.at !== "number" || !Number.isFinite(row.at)) return undefined;
  if (row.op === "remove") return { op: "remove", id: row.id, at: row.at };
  if (typeof row.text !== "string" || typeof row.source !== "number" || !Number.isSafeInteger(row.source) || row.source < 0) {
    return undefined;
  }
  if (row.op === "add") return { op: "add", id: row.id, text: row.text, source: row.source, at: row.at };
  if (row.op === "replace" && typeof row.replaces === "string" && ID.test(row.replaces)) {
    return { op: "replace", id: row.id, replaces: row.replaces, text: row.text, source: row.source, at: row.at };
  }
  return undefined;
}

/**
 * The rules ledger: append-only JSON lines, one fsynced write per event. Replay keeps every well-formed line and
 * skips a torn or malformed one; the next append starts on a fresh line. Only the leased session writes it.
 */
export class RuleLedger {
  private readonly path: string;
  private readonly rules = new Map<string, Rule>();
  private sequence = 0;
  private needsNewline = false;
  private closed = false;

  private constructor(directory: string) {
    this.path = join(directory, LEDGER_FILE);
  }

  /** Replays the ledger at `directory`; a missing file is an empty ledger and is not created until the first event. */
  static open(directory: string): RuleLedger {
    const ledger = new RuleLedger(directory);
    ledger.replay();
    return ledger;
  }

  /** Active rules in the order they were added. */
  active(): Rule[] {
    return [...this.rules.values()];
  }

  add(source: number, text: string, at: number): Rule {
    const id = this.nextId();
    const clipped = clipRule(text, source);
    this.write({ op: "add", id, text: clipped, source, at });
    return this.rules.get(id)!;
  }

  /** Replaces an active rule with a new one. The old id must be active; the caller decides that first. */
  replace(replaces: string, source: number, text: string, at: number): Rule {
    if (!this.rules.has(replaces)) throw new Error(`no active rule ${replaces}`);
    const id = this.nextId();
    this.write({ op: "replace", id, replaces, text: clipRule(text, source), source, at });
    return this.rules.get(id)!;
  }

  /** Removes an active rule; false when no active rule has this id. */
  remove(id: string, at: number): boolean {
    if (!this.rules.has(id)) return false;
    this.write({ op: "remove", id, at });
    return true;
  }

  /** Later writes fail: a triage job that outlives the session cannot append after its store closes. */
  close(): void {
    this.closed = true;
  }

  private nextId(): string {
    return `r${this.sequence + 1}`;
  }

  private replay(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.needsNewline = text.length > 0 && !text.endsWith("\n");
    const lines = text.split("\n");
    // The final segment is complete only when the text ends with a newline; otherwise it is torn and skipped.
    if (this.needsNewline) lines.pop();
    for (const line of lines) {
      if (line.length === 0) continue;
      let event: Event | undefined;
      try {
        event = eventOf(JSON.parse(line));
      } catch {
        event = undefined;
      }
      if (event) this.apply(event);
    }
  }

  private apply(event: Event): void {
    const sequence = Number(event.id.slice(1));
    if (sequence > this.sequence) this.sequence = sequence;
    if (event.op === "remove") {
      this.rules.delete(event.id);
      return;
    }
    if (event.op === "replace") this.rules.delete(event.replaces);
    this.rules.set(event.id, { id: event.id, text: event.text, source: event.source, at: event.at });
  }

  private write(event: Event): void {
    if (this.closed) throw new Error("the rules ledger is closed");
    const prefix = this.needsNewline ? "\n" : "";
    const bytes = Buffer.from(`${prefix}${JSON.stringify(event)}\n`, "utf8");
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      // Set before the write: a failed or short write may leave a torn line, and the next append must start fresh.
      this.needsNewline = true;
      if (writeSync(fd, bytes) !== bytes.length) throw new Error("Short rules ledger write; the next start replays the torn line");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.needsNewline = false;
    this.apply(event);
  }
}

/** The block rendered after the view: one `r<k> [<message id>] <text>` line per rule. */
export function renderRules(rules: readonly Rule[]): string {
  return ["<rules>", ...rules.map((rule) => `${rule.id} [${rule.source}] ${rule.text}`), "</rules>"].join("\n");
}
