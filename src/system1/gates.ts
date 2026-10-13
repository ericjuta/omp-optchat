import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import type { GateConfig } from "../config.js";

/** The four System One gates, keyed as in GateConfig, in status order. */
export const GATE_KEYS = ["rules", "prefetch", "valueScore", "recall"] as const;
export type GateKey = (typeof GATE_KEYS)[number];

/** Each gate's name in status lines and recorded failures. */
export const GATE_LABEL: Readonly<Record<GateKey, string>> = {
  rules: "rules",
  prefetch: "prefetch",
  valueScore: "value-score",
  recall: "recall",
};

/** The purpose each gate's judgments carry: labels the host's usage journal and telemetry. */
export const GATE_PURPOSE: Readonly<Record<GateKey, string>> = {
  rules: "optchat-rules",
  prefetch: "optchat-prefetch",
  valueScore: "optchat-value",
  recall: "optchat-recall",
};

/** Why no gate runs when the judge is the session-model fallback. */
export const INACTIVE_REASON = "no native judge model (judge role resolves to session model)";

/** Outcome counts per gate, besides judge calls and failures. Each is a count of what the gate did. */
export const OUTCOMES: Readonly<Record<GateKey, readonly string[]>> = {
  rules: ["added", "replaced"],
  prefetch: ["blocks", "bytes"],
  valueScore: ["hints"],
  recall: ["answered", "none", "failed"],
};

/** A gate's judge for one call: a judge, no judge (failure already recorded), or inactive on the session fallback. */
export type Judging = { readonly kind: "judge"; readonly judge: Judge } | { readonly kind: "none" } | { readonly kind: "inactive" };

/** The judge with `onCall` run before every judgment, so calls are counted at the point they are made. */
export function counted(judge: Judge, onCall: () => void): Judge {
  return {
    label: judge.label,
    judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
      onCall();
      return judge.judge(request, options);
    },
  };
}

/**
 * Per-gate counts since OptChat started, for `/optchat status` only: in memory, saturating at
 * Number.MAX_SAFE_INTEGER, never in the system prompt, the view or any provider request.
 */
export class GateCounts {
  readonly #counts = new Map<string, number>();

  /** Adds `by` to one count. */
  add(gate: GateKey, what: string, by = 1): void {
    const key = `${gate}.${what}`;
    this.#counts.set(key, Math.min(Number.MAX_SAFE_INTEGER, (this.#counts.get(key) ?? 0) + by));
  }

  /** One status line per gate that is on: judge calls, failures, then its outcomes. */
  lines(gates: GateConfig): string[] {
    const count = (gate: GateKey, what: string): number => this.#counts.get(`${gate}.${what}`) ?? 0;
    return GATE_KEYS.filter((gate) => gates[gate]).map((gate) => {
      const parts = [
        `${count(gate, "calls")} judge calls`,
        `${count(gate, "failures")} failures`,
        ...OUTCOMES[gate].map((what) => `${count(gate, what)} ${what}`),
      ];
      return `${GATE_LABEL[gate]} counts: ${parts.join(", ")}`;
    });
  }
}
