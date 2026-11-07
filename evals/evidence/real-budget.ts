import { createHash } from "node:crypto";

/** Legacy provider-enforced authorization, not the best-effort allocation limit. */
export const TOTAL_BUDGET_NANO_USD = 5_000_000_000;
export const BEST_EFFORT_POLICY = Object.freeze({
  mode: "best-effort", limitUsd: 50, priorAllowanceUsd: 16,
  maxRecallCalls: 1200, maxExtractionCalls: 80,
  recallAllowanceUsd: 0.025, extractionAllowanceUsd: 0.05, maxRequestBytes: 262144,
} as const);
export type BestEffortPolicy = typeof BEST_EFFORT_POLICY;
export const MISSING_BUDGET_PREREQUISITE =
  "No manifest-bound budget authority: live execution requires the exact approved frozen best-effort policy or a verified provider-enforced reservation integration";

export type RealArm = "A" | "B" | "C";
export type KnownCost = { status: "known"; usd: number; basis: string } | { status: "unknown"; reason: string };
export interface PaidCall {
  readonly caseId: string;
  readonly repetition: number;
  readonly arm: "A" | "C";
  readonly requestSha256: string;
  /** UTF-8 bytes of the request representation bound by requestSha256, not a token/price estimate. */
  readonly requestBytes: number;
}
export interface Reservation {
  /** Enforced upper bound for this whole operation, including failures and any hidden retries. Never a price estimate. */
  readonly upperBoundNanoUsd: number;
  readonly receiptId: string;
  readonly evidenceSha256: string;
}
/**
 * A trusted provider-enforcement integration, NOT an operator assertion or JSON price table.
 * No such integration is currently installed. An integration must reserve before returning,
 * guarantee the bound even if transport fails, include all spending against its $5 authorization
 * (including grading), and bind enforcement evidence to this manifest. Null MUST send no paid request.
 */
export interface EnforcedReservationAuthority {
  readonly mode?: "enforced";
  readonly manifestSha256: string;
  readonly evidenceSha256: string;
  readonly mechanism: string;
  readonly priorReservedNanoUsd: number;
  reserve(call: PaidCall, remainingNanoUsd: number): Promise<Reservation | null>;
}
/** Local admission policy only. Neither this object nor its digest proves provider-side enforcement. */
export interface BestEffortAuthority {
  readonly mode: "best-effort";
  readonly manifestSha256: string;
  readonly policy: BestEffortPolicy;
  readonly policySha256: string;
}
export type ReservationAuthority = EnforcedReservationAuthority | BestEffortAuthority;
export interface AllowanceAllocation {
  readonly allowanceNanoUsd: number;
  readonly policySha256: string;
  readonly guaranteed: false;
}
export type PaidReceipt = {
  readonly call: PaidCall;
  readonly startedAt: string;
  readonly ms: number;
  readonly outcome: "returned" | "failed";
  readonly cost: KnownCost;
} & (
  | { readonly reservation: Reservation; readonly allocation?: never }
  | { readonly allocation: AllowanceAllocation; readonly reservation?: never }
);

export function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
/** Reject altered, missing or extra policy fields; callers cannot raise limits via JSON. */
export function validateBestEffortPolicy(value: unknown): BestEffortPolicy {
  const expected = Object.entries(BEST_EFFORT_POLICY);
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== expected.length ||
    expected.some(([key, field]) => !Object.hasOwn(value, key) || Reflect.get(value, key) !== field)) {
    throw new Error("Budget policy must exactly match the approved frozen $50 best-effort policy");
  }
  return BEST_EFFORT_POLICY;
}
export function makeBestEffortAuthority(manifestSha256: string, policy: BestEffortPolicy): BestEffortAuthority {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("Invalid budget manifest SHA-256");
  const frozen = validateBestEffortPolicy(policy);
  return Object.freeze({ mode: "best-effort", manifestSha256, policy: frozen, policySha256: digest(JSON.stringify(frozen)) });
}
export function positiveReportedCost(value: unknown, basis: string): KnownCost {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { status: "known", usd: value, basis }
    : { status: "unknown", reason: "Provider/host returned no positive finite cost; zero is not proof of free inference" };
}
const validAmount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && n <= TOTAL_BUDGET_NANO_USD;

/**
 * Only admission/accounting is FIFO across A and C. Invocations retain the caller's concurrency
 * and deadlines. Cancellation latches a run-wide halt immediately, not at settlement. Queued
 * and admitted calls stay tracked until they settle; drain never substitutes an abort race for
 * settlement. Accepted reservations OR best-effort allocations are never refunded, including
 * failures, unknown-cost calls and cancellation before dispatch. Allocations are NOT actual spend.
 */
export class SerialBudget {
  private tail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<unknown>>();
  private committed: number;
  private halt: string | undefined;
  private readonly limitNanoUsd: number;
  private readonly callsByArm = { A: 0, C: 0 };
  readonly policy: BestEffortPolicy | undefined;
  readonly receipts: PaidReceipt[] = [];
  constructor(
    readonly manifestSha256: string,
    private readonly authority: ReservationAuthority | undefined,
    private readonly persist: (event: object) => void,
  ) {
    if (authority?.mode === "best-effort") {
      this.policy = validateBestEffortPolicy(authority.policy);
      if (authority.manifestSha256 !== manifestSha256 || !/^[a-f0-9]{64}$/.test(manifestSha256) ||
        authority.policySha256 !== digest(JSON.stringify(this.policy))) throw new Error("Invalid or mismatched best-effort authority");
      // Retain the validated frozen policy, not a caller-owned mutable authority object.
      this.authority = makeBestEffortAuthority(manifestSha256, this.policy);
      this.committed = this.policy.priorAllowanceUsd * 1e9;
      this.limitNanoUsd = this.policy.limitUsd * 1e9;
    } else {
      if (authority && (authority.manifestSha256 !== manifestSha256 || !/^[a-f0-9]{64}$/.test(authority.evidenceSha256) ||
        !authority.mechanism.trim() || !validAmount(authority.priorReservedNanoUsd))) {
        throw new Error("Invalid or mismatched enforcement authority");
      }
      this.committed = authority?.priorReservedNanoUsd ?? 0;
      this.limitNanoUsd = TOTAL_BUDGET_NANO_USD;
    }
  }
  get status() {
    return {
      mode: this.policy ? "best-effort" : this.authority ? "enforced" : "missing",
      limitNanoUsd: this.limitNanoUsd, capNanoUsd: this.policy ? null : TOTAL_BUDGET_NANO_USD,
      reservedNanoUsd: this.policy ? 0 : this.committed, allocatedNanoUsd: this.policy ? this.committed : 0,
      guaranteed: !!this.authority && !this.policy,
      policy: this.policy ?? null,
      policySha256: this.authority?.mode === "best-effort" ? this.authority.policySha256 : null,
      priorAllowanceNanoUsd: this.policy ? this.policy.priorAllowanceUsd * 1e9 : 0,
      admittedCalls: { ...this.callsByArm },
      knownReportedUsd: this.receipts.reduce((sum, row) => sum + (row.cost.status === "known" ? row.cost.usd : 0), 0),
      unknownCalls: this.receipts.filter((row) => row.cost.status === "unknown").length,
      halted: this.halt ?? null,
      enforcement: this.authority?.mode === "best-effort" ? "none; local best-effort allocations are not a provider spending cap"
        : this.authority?.mechanism ?? "missing",
      enforcementEvidenceSha256: this.authority?.mode === "best-effort" ? null : this.authority?.evidenceSha256 ?? null,
    };
  }
  /** Stop future admissions without claiming that outstanding provider operations were cancelled or free. */
  stop(reason: string): void { this.halt ??= reason; }
  assertAvailable(): void {
    if (!this.authority) throw new Error(MISSING_BUDGET_PREREQUISITE);
    if (this.halt) throw new Error(this.halt);
    if (this.committed >= this.limitNanoUsd) throw new Error("All authorized budget is allocated or reserved; no paid call admitted");
  }
  /** Also usable at the actual transport boundary after credentials resolve, without allocating twice. */
  assertRequestBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || (this.policy && bytes > this.policy.maxRequestBytes)) {
      this.stop("Paid request bytes are invalid or exceed the frozen best-effort request limit");
      throw new Error(this.halt);
    }
    if (this.halt) throw new Error(this.halt);
  }
  run<T>(call: PaidCall, signal: AbortSignal | undefined, invoke: () => Promise<T>, cost: (value: T) => KnownCost): Promise<T> {
    const onAbort = () => { this.stop("Paid operation was cancelled; no further paid calls admitted"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const pending = this.execute(call, signal, invoke, cost);
    this.inFlight.add(pending);
    const settled = () => {
      signal?.removeEventListener("abort", onAbort);
      this.inFlight.delete(pending);
    };
    // Handle both outcomes without a detached rejecting finally() promise. Cancellation does not
    // remove a call: recall may have stopped waiting while its invocation is still settling.
    void pending.then(settled, settled);
    return pending;
  }
  private record(event: object): void {
    try { this.persist(event); }
    catch {
      this.stop("Budget receipt persistence failed; all further paid calls blocked");
      throw new Error(this.halt);
    }
  }
  private async execute<T>(call: PaidCall, signal: AbortSignal | undefined, invoke: () => Promise<T>, cost: (value: T) => KnownCost): Promise<T> {
    const previous = this.tail;
    const admission = Promise.withResolvers<void>();
    this.tail = admission.promise;
    let admitted: { entry: { reservation: Reservation } | { allocation: AllowanceAllocation }; allowanceNanoUsd: number; startedAt: string; start: number } | undefined;
    let outcome: PaidReceipt["outcome"] = "failed";
    let observed: KnownCost = { status: "unknown", reason: "Operation failed or did not return billing information" };
    try {
      try {
        await previous;
        signal?.throwIfAborted();
        this.assertAvailable();
        this.assertRequestBytes(call.requestBytes);
        if (call.arm !== "A" && call.arm !== "C") throw new Error("Unknown paid arm; no paid call admitted");
        let entry: { reservation: Reservation } | { allocation: AllowanceAllocation };
        let allowanceNanoUsd: number;
        if (this.authority?.mode === "best-effort") {
          const policy = this.authority.policy;
          const maxCalls = call.arm === "A" ? policy.maxRecallCalls : policy.maxExtractionCalls;
          allowanceNanoUsd = (call.arm === "A" ? policy.recallAllowanceUsd : policy.extractionAllowanceUsd) * 1e9;
          if (this.callsByArm[call.arm] >= maxCalls || allowanceNanoUsd > this.limitNanoUsd - this.committed) {
            this.stop("Frozen best-effort per-arm count or allocation limit reached; no paid call admitted");
            throw new Error(this.halt);
          }
          entry = { allocation: { allowanceNanoUsd, policySha256: this.authority.policySha256, guaranteed: false } };
        } else {
          let reservation: Reservation | null;
          try {
            reservation = await this.authority!.reserve(call, this.limitNanoUsd - this.committed);
          } catch {
            this.stop("Reservation failed with unknown enforcement state; all further paid calls blocked");
            throw new Error(this.halt);
          }
          if (!reservation) throw new Error("Enforcement authority refused a reservation; call not sent");
          if (!validAmount(reservation.upperBoundNanoUsd) || reservation.upperBoundNanoUsd === 0 ||
            reservation.upperBoundNanoUsd > this.limitNanoUsd - this.committed ||
            reservation.evidenceSha256 !== this.authority!.evidenceSha256 || !reservation.receiptId) {
            this.stop("Invalid enforcement reservation; all further paid calls blocked");
            throw new Error(this.halt);
          }
          allowanceNanoUsd = reservation.upperBoundNanoUsd;
          entry = { reservation };
        }
        // A reserve already in progress can finish after cancellation or another call's overrun.
        // Account for it before checking the halt again; no accepted commitment is refunded.
        this.committed += allowanceNanoUsd;
        this.callsByArm[call.arm]++;
        admitted = { entry, allowanceNanoUsd, startedAt: new Date().toISOString(), start: performance.now() };
        this.record("allocation" in entry
          ? { type: "allocated", call, allocation: entry.allocation, totalAllocatedNanoUsd: this.committed }
          : { type: "reserved", call, reservation: entry.reservation, totalReservedNanoUsd: this.committed });
      } finally { admission.resolve(); }
      signal?.throwIfAborted();
      if (this.halt) throw new Error(this.halt);
      // Do not hold the admission queue while invoking or awaiting the provider.
      const value = await invoke();
      observed = cost(value);
      if (observed.status === "known" && observed.usd > admitted.allowanceNanoUsd / 1e9) {
        this.stop(this.policy ? "Reported cost exceeded best-effort allowance; all further paid calls blocked"
          : "Reported cost exceeded enforced reservation; enforcement guarantee violated");
        throw new Error(this.halt);
      }
      signal?.throwIfAborted();
      if (this.halt) throw new Error(this.halt);
      outcome = "returned";
      return value;
    } finally {
      if (admitted) {
        const receipt: PaidReceipt = {
          call, ...admitted.entry, startedAt: admitted.startedAt,
          ms: performance.now() - admitted.start, outcome, cost: observed,
        };
        this.receipts.push(receipt);
        // Preserve known reported overruns even though the call rejects. Unknown remains unknown.
        this.record({ type: "settled", ...receipt });
      }
    }
  }
  /** Wait for admitted invocations (including cancelled ones) and queued admission/trace continuations. */
  async drain(): Promise<void> {
    for (;;) {
      const tail = this.tail;
      await Promise.allSettled(this.inFlight);
      // Let recall's timeout/fallback continuations enqueue or reject their remaining work.
      const continuation = Promise.withResolvers<void>();
      setImmediate(continuation.resolve);
      await continuation.promise;
      if (tail === this.tail && this.inFlight.size === 0) return;
    }
  }
}
