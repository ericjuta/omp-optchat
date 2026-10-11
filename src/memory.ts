import { Buffer } from "node:buffer";
import { RULER } from "./prompts.js";
import { nodeKey, type Kind, type Message, Store, type TreeNode } from "./store.js";

export interface CompactionRequest {
  context: string;
  instruction: string;
  feedback: ReadonlyArray<{ reply: string; instruction: string }>;
}

export type Summarize = (
  request: CompactionRequest,
  signal: AbortSignal,
) => Promise<string>;

export interface MemoryOptions {
  nodeBytes?: number;
  viewBytes?: number;
  /** Upper compactor-context threshold; each batch targets half this size. */
  compactionViewBytes?: number;
  jobs?: number;
  tries?: number;
  retryMs?: number;
  report?: (message: string) => void;
  /** Injectable retry clock; implementations must settle when signal aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ViewPart {
  readonly l: number;
  readonly i: number;
}

interface Job {
  controller: AbortController;
  done: Promise<void>;
}

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Cut at a byte boundary without manufacturing a replacement character. */
export function utf8Prefix(text: string, budget: number): string {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError("UTF-8 budget must be a nonnegative safe integer");
  }
  if (utf8Bytes(text) <= budget) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = budget;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

const PLACEHOLDER = "(not summarized yet: zoom it)";
const PLACEHOLDER_BYTES = utf8Bytes(PLACEHOLDER);
const flatten = (text: string): string => text.replace(/\r\n|\r|\n/g, " ");
const chat = (lines: string[]): string => ["<chat>", ...lines, "</chat>"].join("\n");

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return result;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const finish = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal.addEventListener("abort", finish, { once: true });
  return promise;
}

/**
 * An append-only binary summary tree with a live, never-split view. Store owns
 * durability; call close() before closing Store, even after a cancelled turn.
 */
export class Memory {
  private readonly nodeBytes: number;
  private readonly budget: number;
  private readonly target: number;
  private readonly compactionBudget: number;
  private readonly compactionTarget: number;
  private readonly jobs: number;
  private readonly tries: number;
  private readonly retryMs: number;
  private readonly report: (message: string) => void;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private view: ViewPart[] = [];
  private compacting = false;
  private compactionView: ViewPart[] = [];
  private compactionEnd = 0;
  private compactionBytes = 0;
  private compactionPending = true;
  private readonly busy = new Map<string, Job>();
  private readonly failed = new Set<string>();
  // Built prefixes can never become unbuilt. Skip them on subsequent scans.
  private readonly firstMissing: number[] = [];
  private readonly waiters = new Set<(settled: boolean) => void>();
  private bytes = 0;
  private first = 0;
  private queued = false;
  private stopped = false;
  private closing: Promise<void> | undefined;

  constructor(
    readonly store: Store,
    private readonly summarize: Summarize,
    options: MemoryOptions = {},
  ) {
    this.nodeBytes = positive(options.nodeBytes, 512, "nodeBytes");
    this.budget = positive(options.viewBytes, 128_000, "viewBytes");
    this.target = Math.max(1, Math.floor(this.budget / 2));
    this.compactionBudget = positive(options.compactionViewBytes, 32_000, "compactionViewBytes");
    this.compactionTarget = Math.max(1, Math.floor(this.compactionBudget / 2));
    this.jobs = positive(options.jobs, 8, "jobs");
    this.tries = positive(options.tries, 5, "tries");
    this.retryMs = options.retryMs ?? 10_000;
    if (!Number.isSafeInteger(this.retryMs) || this.retryMs < 0 || this.retryMs > 2_147_483_647) {
      throw new RangeError("retryMs must be an integer between 0 and 2147483647");
    }
    this.report = options.report ?? ((message) => console.error(message));
    this.wait = options.wait ?? delay;
    const snapshot = store.viewSnapshot;
    this.view = snapshot?.parts.map(([l, i]) => ({ l, i })) ?? [];
    this.compacting = snapshot?.compacting ?? false;
    // A crash can leave durable log records after the last view commit. Keep
    // its exact prefix; only a store with no snapshot needs a one-time migration.
    for (let i = snapshot?.length ?? 0; i < store.messages.length; i++) {
      this.view.push({ l: 0, i });
    }
    this.advanceFirst();
    this.fit(this.view, !snapshot || snapshot.length !== store.messages.length);
    this.schedulePump();
  }

  append(kind: Kind, text: string, date?: Date): Message {
    if (this.stopped) throw new Error("Memory is closed");
    const message = this.store.append(kind, text, date);
    this.fit([...this.view, { l: 0, i: message.i }], true);
    this.schedulePump();
    return message;
  }

  /** A copied snapshot for browsing; callers cannot mutate the live tiling. */
  viewParts(): ReadonlyArray<ViewPart> {
    return this.view.map(({ l, i }) => ({ l, i }));
  }

  settle(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped || signal?.aborted) return Promise.resolve(false);
    if (this.first === this.store.messages.length) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const finish = (settled: boolean) => {
      this.waiters.delete(finish);
      signal?.removeEventListener("abort", abort);
      resolve(settled);
    };
    const abort = () => finish(false);
    this.waiters.add(finish);
    signal?.addEventListener("abort", abort, { once: true });
    return promise;
  }

  render(): string {
    return chat(this.view.map((part) => this.renderPart(part)));
  }

  zoom(id: number, n: number): string {
    const level = Math.log2(n);
    if (
      !Number.isSafeInteger(id) || id < 0 ||
      !Number.isSafeInteger(n) || n <= 0 || 2 ** level !== n || !Number.isInteger(level) ||
      id % n !== 0 || id > this.store.messages.length - n
    ) {
      return `No line ${id}+${n}.`;
    }
    if (n === 1) {
      const message = this.store.messages[id]!;
      return `${id}+0|${message.kind}: ${message.text}`;
    }
    const left = { l: level - 1, i: (id / n) * 2 };
    const right = { l: level - 1, i: left.i + 1 };
    if (!this.node(left) || !this.node(right)) return `No line ${id}+${n}.`;
    return `${this.renderPart(left)}\n${this.renderPart(right)}`;
  }

  date(id: number): string {
    if (!Number.isSafeInteger(id) || id < 0 || id >= this.store.messages.length) {
      return `No message ${id}.`;
    }
    return new Date(this.store.messages[id]!.date).toLocaleString();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.wake(false);
    const jobs = [...this.busy.values()];
    // Assign before aborting: an abort listener may synchronously call close.
    this.closing = Promise.all(jobs.map((job) => job.done)).then(() => undefined);
    for (const job of jobs) job.controller.abort();
    return this.closing;
  }

  status(): { messages: number; nodes: number; pending: number; viewBytes: number; parts: number } {
    return {
      messages: this.store.messages.length,
      nodes: this.store.nodes.size,
      pending: this.busy.size,
      viewBytes: this.bytes,
      parts: this.view.length,
    };
  }

  private node(part: ViewPart): TreeNode | undefined {
    return this.store.nodes.get(nodeKey(part.l, part.i));
  }

  private renderPart(part: ViewPart): string {
    const n = 2 ** part.l;
    return `${part.i * n}+${n}|${flatten(this.node(part)?.text ?? PLACEHOLDER)}`;
  }

  private size(parts: readonly ViewPart[]): number {
    let bytes = 0;
    for (const part of parts) bytes += this.node(part)?.size ?? PLACEHOLDER_BYTES;
    return bytes;
  }

  /** Merge oldest equal-due siblings. Age is measured from the pair's LAST
   * message, not its first: at T=10, 8+1|9+1 precedes 0+4|4+4. */
  private coarsen(parts: ViewPart[], bytes: number, target: number): number {
    const length = this.store.messages.length;
    while (bytes > target) {
      let best = -1;
      let due = -1;
      let parent: TreeNode | undefined;
      for (let j = 0; j + 1 < parts.length; j++) {
        const a = parts[j]!;
        const b = parts[j + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const candidate = this.store.nodes.get(nodeKey(a.l + 1, a.i / 2));
        if (!candidate) continue;
        const width = 2 ** a.l;
        const age = (length - ((a.i + 2) * width - 1)) / width;
        if (age > due) {
          best = j;
          due = age;
          parent = candidate;
        }
      }
      if (best < 0 || !parent) break;
      bytes += parent.size - this.node(parts[best]!)!.size - this.node(parts[best + 1]!)!.size;
      parts.splice(best, 2, { l: parent.l, i: parent.i });
    }
    return bytes;
  }

  private advanceFirst(): void {
    while (this.first < this.store.messages.length && this.store.nodes.has(nodeKey(0, this.first))) this.first++;
  }

  private fit(proposed: ViewPart[] = this.view, persist = false): void {
    let bytes = this.size(proposed);
    let compacting = this.compacting || bytes > this.budget;
    let merged = false;
    if (compacting) {
      // Do not publish a changed tiling before its atomic snapshot is durable.
      proposed = proposed.slice();
      const count = proposed.length;
      bytes = this.coarsen(proposed, bytes, this.target);
      merged = proposed.length !== count;
      compacting = bytes > this.target;
    }
    if (persist || merged || compacting !== this.compacting) {
      this.store.saveView({
        version: 1,
        length: this.store.messages.length,
        parts: proposed.map(({ l, i }) => [l, i] as const),
        compacting,
      });
    }
    this.view = proposed;
    this.bytes = bytes;
    this.compacting = compacting;
    this.refreshCompactionView(merged);
    if (this.first === this.store.messages.length) this.wake(true);
  }

  private refreshCompactionView(reset = false): void {
    if (reset) {
      this.compactionView = [];
      this.compactionEnd = 0;
      this.compactionBytes = 0;
      this.compactionPending = true;
    }
    for (const part of this.view) {
      const width = 2 ** part.l;
      const end = (part.i + 1) * width;
      if (end <= this.compactionEnd) continue;
      if (end > this.first) break;
      const node = this.node(part);
      if (!node) break;
      this.compactionView.push(part);
      this.compactionEnd = end;
      this.compactionBytes += node.size;
    }
    if (this.compactionBytes > this.compactionBudget) this.compactionPending = true;
    if (this.compactionPending) {
      this.compactionBytes = this.coarsen(this.compactionView, this.compactionBytes, this.compactionTarget);
      this.compactionPending = this.compactionBytes > this.compactionTarget;
    }
  }

  private wake(settled: boolean): void {
    for (const finish of this.waiters) finish(settled);
  }

  private context(end: number): string {
    const lines: string[] = [];
    for (const part of this.compactionView) {
      // A coarse line that straddles the request boundary contains future
      // messages too. Omit it, rather than leaking those messages as context.
      if ((part.i + 1) * 2 ** part.l > end) break;
      const node = this.node(part);
      if (!node) break;
      lines.push(this.renderPart(part));
    }
    return chat(lines);
  }

  private schedulePump(): void {
    if (this.queued || this.stopped) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.stopped) this.pump();
    });
  }

  private pump(): void {
    const length = this.store.messages.length;
    for (let l = 0, width = 1; width <= length; l++, width *= 2) {
      if (this.busy.size >= this.jobs) return;
      const count = l === 0 ? Math.min(length, this.first + 1) : Math.floor(this.first / width);
      let i = this.firstMissing[l] ?? 0;
      while (i < count && this.store.nodes.has(nodeKey(l, i))) i++;
      this.firstMissing[l] = i;
      for (; i < count; i++) {
        if (this.busy.size >= this.jobs) return;
        const key = nodeKey(l, i);
        if (this.store.nodes.has(key) || this.busy.has(key)) continue;
        if (l > 0 && (
          !this.store.nodes.has(nodeKey(l - 1, i * 2)) ||
          !this.store.nodes.has(nodeKey(l - 1, i * 2 + 1))
        )) continue;
        this.start({ l, i }, key);
      }
    }
  }

  private start(part: ViewPart, key: string): void {
    const controller = new AbortController();
    // Defer build until job.done is published: providers may call close during
    // their synchronous preamble, and close must await their actual promise.
    const work = Promise.resolve().then(() => this.build(part, controller.signal));
    const job: Job = {
      controller,
      done: work.then(
        () => { this.failed.delete(key); },
        async (error: unknown) => {
          if (this.stopped || controller.signal.aborted) return;
          if (!this.failed.has(key)) {
            this.failed.add(key);
            // Rejection values are arbitrary: formatting itself may throw.
            let detail = "unprintable error";
            try {
              detail = String(error instanceof Error ? error.message : error);
            } catch {
              // Keep the fallback; the retry must still be scheduled.
            }
            try {
              // Detached, not awaited: a reporter may call close(), which awaits this job.
              void Promise.resolve(
                this.report(`OptChat compaction failed at ${part.i * 2 ** part.l}+${2 ** part.l}; retrying in ${this.retryMs}ms: ${detail}`),
              ).catch(() => {});
            } catch {
              // Diagnostics must not break compaction or escape as unhandled work.
            }
          }
          if (this.stopped || controller.signal.aborted) return;
          try {
            await this.wait(this.retryMs, controller.signal);
          } catch {
            // Aborting a retry clock may reject rather than resolve.
          }
        },
      ).finally(() => {
        this.busy.delete(key);
        this.schedulePump();
      }),
    };
    this.busy.set(key, job);
  }

  private async build(part: ViewPart, signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted) return;
    let source: string;
    let left: TreeNode | undefined;
    let right: TreeNode | undefined;
    if (part.l === 0) {
      const message = this.store.messages[part.i]!;
      source = `${message.kind}: ${message.text}`;
    } else {
      left = this.store.nodes.get(nodeKey(part.l - 1, part.i * 2))!;
      right = this.store.nodes.get(nodeKey(part.l - 1, part.i * 2 + 1))!;
      source = `${left.text}\n${right.text}`;
    }
    let text = source;
    let size = utf8Bytes(source);
    if (size > this.nodeBytes) {
      const input = left && right ? `${flatten(left.text)}\n${flatten(right.text)}` : source;
      const end = part.l === 0 ? part.i : (part.i + 1) * 2 ** part.l;
      const context = this.context(end);
      const id = part.i * 2 ** part.l;
      const task = part.l === 0
        ? `compress message ${id}`
        : `merge lines ${id}+${2 ** (part.l - 1)} and ${id + 2 ** (part.l - 1)}+${2 ** (part.l - 1)}, adjacent,`;
      const details = part.l === 0 ? "" : `<chat> may hold their messages, ${id} to ${end - 1}, in more detail: take details\nof them from there too.\n`;
      const ruler = this.nodeBytes === 512
        ? "(about 70 words), the length of this ruler:"
        : "The ruler is a fixed 512-byte reference; the numeric limit above is authoritative:";
      const instruction = `Compaction: ${task} into one line of at most ${this.nodeBytes} bytes\n${ruler}\n${RULER}\n${details}<input>\n${input}\n</input>`;
      let feedback: CompactionRequest["feedback"] = [];
      let shortest: { text: string; size: number } | undefined;
      for (let attempt = 0; attempt < this.tries; attempt++) {
        const reply = (await this.summarize({ context, instruction, feedback }, signal)).trim();
        if (this.stopped || signal.aborted) return;
        if (!reply) throw new Error("Compactor returned an empty summary");
        const bytes = utf8Bytes(reply);
        if (!shortest || bytes < shortest.size) shortest = { text: reply, size: bytes };
        if (bytes <= this.nodeBytes || attempt + 1 === this.tries) break;
        feedback = [...feedback, {
          reply,
          instruction: `Too long: your line is ${bytes} bytes, over the ${this.nodeBytes}-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${utf8Prefix(reply, this.nodeBytes)}| ← LIMIT`,
        }];
      }
      text = shortest!.text;
      size = shortest!.size;
    }
    if (this.stopped || signal.aborted) return;
    this.store.saveNode({ l: part.l, i: part.i, text, size });
    this.advanceFirst();
    this.fit();
  }
}
