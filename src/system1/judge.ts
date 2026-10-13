import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { type ExtensionContext, settings } from "@oh-my-pi/pi-coding-agent";
import { journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";

/** Resolves the judge for one gate. `undefined` means no judge candidate: the gate cannot run. */
export type JudgeFactory = (ctx: ExtensionContext, purpose: string) => Judge | undefined;

/** A judge that can name its first candidate, as the host ChainJudge does. */
export interface NamedJudge extends Judge {
  primaryModel?(): { provider: string; id: string } | undefined;
  /** True when the judge role has no candidate and the session model answers alone (see `hostJudge`). */
  readonly sessionFallback?: boolean;
}

/** Whether a judge is the session-model fallback rather than a judge-role model. */
export function sessionFallbackOf(judge: Judge): boolean {
  return (judge as NamedJudge).sessionFallback === true;
}

/**
 * The host judge role, resolved per call with usage journaled to this session and the shared answer cache.
 * With no judge-role candidate, the session model is the judge and the result is marked `sessionFallback`; every gate
 * is inactive on it, and `chat_recall` says so. A synchronous resolution failure or an empty candidate chain yields
 * `undefined`; it never throws.
 */
export function hostJudge(ctx: ExtensionContext, purpose: string): Judge | undefined {
  try {
    const deps = {
      settings,
      registry: ctx.modelRegistry,
      sessionModel: ctx.model,
      sessionId: ctx.sessionManager.getSessionId(),
      purpose,
      onUsage: journalJudgmentUsage(ctx.sessionManager),
      cache: sharedJudgmentCache(),
    };
    const judge = resolveJudge(deps);
    if (judge.primaryModel() === undefined) return undefined;
    // The session model is appended only when the role has no candidate of its own: the fallback case.
    const roleCandidate = resolveJudge({ ...deps, sessionModel: undefined }).primaryModel() !== undefined;
    return roleCandidate ? judge : Object.assign(judge, { sessionFallback: true });
  } catch {
    return undefined;
  }
}

/** UTF-8 bytes of a string, without allocating a copy. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Greedy chunks of `items`: each chunk's state is `base` plus the entries of its items, at most `budget` bytes
 * and `maxCount` items. A single item larger than the budget still gets its own chunk; callers bound items first.
 */
export function packByBytes<T>(
  items: readonly T[],
  base: number,
  entryBytes: (item: T) => number,
  budget: number,
  maxCount: number,
): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let bytes = base;
  for (const item of items) {
    const size = entryBytes(item);
    if (chunk.length > 0 && (bytes + size > budget || chunk.length >= maxCount)) {
      chunks.push(chunk);
      chunk = [];
      bytes = base;
    }
    chunk.push(item);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Question-level error text is bounded and never echoes model output. */
export function boundedGateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * One judgment within `ms`, aborted when the bound passes or `parent` aborts. A judge that ignores its signal
 * is abandoned by the race, so the bound always holds.
 */
export async function judgeWithin<Q extends Questions>(
  judge: Judge,
  request: JudgmentRequest<Q>,
  ms: number,
  parent?: AbortSignal,
): Promise<JudgmentResult<Q>> {
  const controller = new AbortController();
  let timer: Timer | undefined;
  const onParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParent();
  parent?.addEventListener("abort", onParent, { once: true });
  const { promise: cancelled, reject } = Promise.withResolvers<never>();
  const stop = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("judgment cancelled"));
  if (controller.signal.aborted) stop();
  controller.signal.addEventListener("abort", stop, { once: true });
  timer = setTimeout(() => controller.abort(new Error(`judgment exceeded ${ms} ms`)), ms);
  try {
    return await Promise.race([
      Promise.resolve().then(() => judge.judge(request, { signal: controller.signal })),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}
