/**
 * The judge the recall eval runs against: OMP's `judge` role, resolved from the user's OMP settings and credential
 * store exactly as the host does (`resolveJudge`), with no answer cache (every rep asks afresh) and no session-model
 * fallback (no judge-role candidate means the eval cannot run). The plugin never holds a key: the host resolves it.
 *
 * `metered` wraps any Judge to count calls, record each request and answer for traces, sum usage, read the served
 * model, enforce a run-wide call budget, and optionally fail a chosen case on purpose (the induced-error pre-flight).
 */
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions, Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";

/** The judge role chain's first model, as `provider/id`, plus the judge and a close hook for the credential store. */
export interface HostJudge {
  readonly judge: Judge;
  readonly primary: string;
  close(): void;
}

/** Resolves the host `judge` role. Throws when the role has no usable candidate. */
export async function openHostJudge(cwd: string, purpose: string): Promise<HostJudge> {
  const settings = await Settings.init({ cwd });
  const auth = await discoverAuthStorage(undefined, { settings });
  try {
    const registry = new ModelRegistry(auth);
    await registry.hydrateCredentialScopedModelCaches();
    const judge = resolveJudge({ settings, registry, purpose });
    const primary = judge.primaryModel();
    if (primary === undefined) throw new Error("the OMP judge role has no usable candidate");
    return { judge, primary: `${primary.provider}/${primary.id}`, close: () => auth.close() };
  } catch (error) {
    auth.close();
    throw error;
  }
}

/** One judge call as a trace records it. `answers` is absent when the call threw. */
export interface JudgeCall {
  readonly state: unknown;
  readonly questions: Questions;
  readonly answers?: unknown;
  readonly model?: string;
  readonly error?: string;
  readonly ms: number;
}

/** Run-wide judge-call budget, shared by every case of one run. */
export class JudgeBudget {
  private spent = 0;
  constructor(readonly limit: number) {}
  get used(): number {
    return this.spent;
  }
  /** Takes one call from the budget; false once it is spent. */
  take(): boolean {
    if (this.spent >= this.limit) return false;
    this.spent++;
    return true;
  }
}

export class BudgetExhaustedError extends Error {
  override name = "BudgetExhaustedError";
}

export class InducedJudgeError extends Error {
  override name = "InducedJudgeError";
}

/** Per-case meter: everything the runner records about the judge for one trial. */
export interface Meter {
  readonly calls: JudgeCall[];
  /** UTF-8 bytes of every request (state plus questions, as JSON) sent to the judge. */
  bytes: number;
  usage: Usage | undefined;
  models: Set<string>;
  /** Calls that threw (transport, timeout, budget, induced). */
  errors: number;
  budgetExhausted: boolean;
}

export function newMeter(): Meter {
  return { calls: [], bytes: 0, usage: undefined, models: new Set(), errors: 0, budgetExhausted: false };
}

const encoder = new TextEncoder();

function addUsage(total: Usage | undefined, next: Usage): Usage {
  if (!total) return structuredClone(next);
  return {
    ...total,
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  };
}

/**
 * `judge`, metered into `meter` and charged to `budget`. With `induce`, every call throws an InducedJudgeError
 * (charged to no budget), which recall turns into a `failed` outcome the runner classes as an API error.
 */
export function metered(judge: Judge, meter: Meter, budget: JudgeBudget, induce = false): Judge {
  return {
    label: judge.label,
    async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
      const started = Date.now();
      meter.bytes += encoder.encode(JSON.stringify({ state: request.state, questions: request.questions })).byteLength;
      const record = (fields: { answers?: unknown; model?: string; error?: string }): void => {
        meter.calls.push({ state: request.state, questions: request.questions, ms: Date.now() - started, ...fields });
      };
      if (induce) {
        meter.errors++;
        record({ error: "induced judge error" });
        throw new InducedJudgeError("induced judge error");
      }
      if (!budget.take()) {
        meter.errors++;
        meter.budgetExhausted = true;
        record({ error: "judge-call budget exhausted" });
        throw new BudgetExhaustedError("judge-call budget exhausted");
      }
      try {
        const result = await judge.judge(request, options);
        meter.usage = addUsage(meter.usage, result.usage);
        meter.models.add(result.model);
        record({ answers: result.answers, model: result.model });
        return result;
      } catch (error) {
        meter.errors++;
        record({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
        throw error;
      }
    },
  };
}
