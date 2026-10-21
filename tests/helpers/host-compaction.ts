/**
 * Shared pieces for tests that drive `session_before_compact` on the fake host: branch entries the way the host's
 * session holds them, and the event with the host's shape. Nothing here calls a model.
 */
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { FakeHost, HostMessage } from "./fake-host.ts";

export function stampOf(message: HostMessage): number {
  if (!("timestamp" in message) || typeof message.timestamp !== "number") throw new Error(`a ${message.role} message has no numeric timestamp`);
  return message.timestamp;
}

export function messageEntry(id: string, message: HostMessage): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(stampOf(message)).toISOString(), message };
}

/** Entries `e1..eN` for `messages`, the way the host's branch holds them. */
export function branchOf(messages: readonly HostMessage[]): SessionEntry[] {
  return messages.map((message, index) => messageEntry(`e${index + 1}`, message));
}

export interface Preparation {
  /** Messages the host would summarize and drop, then the dropped prefix of a split turn. */
  dropped: readonly HostMessage[];
  prefix?: readonly HostMessage[];
  firstKeptEntryId: string;
  tokensBefore?: number;
}

/** Fires `session_before_compact` with the host's event shape and returns the one handler's result. */
export async function compact(host: FakeHost, preparation: Preparation, branchEntries: SessionEntry[]): Promise<unknown> {
  const results = await host.fire("session_before_compact", {
    preparation: {
      firstKeptEntryId: preparation.firstKeptEntryId,
      messagesToSummarize: [...preparation.dropped],
      turnPrefixMessages: [...(preparation.prefix ?? [])],
      recentMessages: [],
      isSplitTurn: (preparation.prefix ?? []).length > 0,
      tokensBefore: preparation.tokensBefore ?? 1000,
    },
    branchEntries,
    signal: new AbortController().signal,
  });
  if (results.length !== 1) throw new Error(`expected one session_before_compact handler, got ${results.length}`);
  return results[0];
}
