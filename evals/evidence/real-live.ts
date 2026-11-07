import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { EXTRACT_MS, openRouterExtractor, type Extraction } from "../../src/system1/extract.ts";
import { digest, positiveReportedCost, SerialBudget, type PaidCall } from "./real-budget.ts";
import { assertSafeOutgoing } from "./real-privacy.ts";

export interface JudgeTrace {
  readonly requestSha256: string;
  readonly outcome: "returned" | "failed" | "blocked";
  readonly model: string | "unknown";
  /** Winner-only host usage: may omit charged fallback attempts and use catalog prices. Not operation billing. */
  readonly usage: unknown;
  readonly answers: unknown;
}
export interface PaidRuntime {
  readonly primaryJudge: string;
  judge(call: Omit<PaidCall, "requestSha256" | "requestBytes">, traces: JudgeTrace[]): Judge;
  extract(call: Omit<PaidCall, "requestSha256" | "requestBytes">, state: string, question: string, signal: AbortSignal): Promise<Extraction>;
  /** The owner must await budget.drain() before closing credentials. */
  close(): void;
}

/** Never called in offline modes or before exact manifest approval and budget-policy admission. */
export async function openPaidRuntime(budget: SerialBudget, cwd: string, arms: readonly string[]): Promise<PaidRuntime> {
  budget.assertAvailable();
  const host = arms.includes("A") ? await (await import("../recall/judge.ts")).openHostJudge(cwd, "real-evidence-eval") : undefined;
  let closeAuth = () => {};
  try {
    let extractor: ReturnType<typeof openRouterExtractor> | undefined;
    if (arms.includes("C")) {
      const [{ Settings }, { discoverAuthStorage }, { ModelRegistry }] = await Promise.all([
        import("@oh-my-pi/pi-coding-agent"), import("@oh-my-pi/pi-coding-agent/sdk"), import("@oh-my-pi/pi-coding-agent/config/model-registry"),
      ]);
      const settings = await Settings.init({ cwd });
      const auth = await discoverAuthStorage(undefined, { settings });
      closeAuth = () => auth.close();
      const registry = new ModelRegistry(auth);
      extractor = openRouterExtractor(() => registry.getApiKeyForProvider("openrouter"), (url, init) => {
        // Bound the exact production HTTP body as well as the input receipt. Do not duplicate
        // production's serializer or mistake its schema/framing overhead for free bytes.
        if (typeof init.body !== "string") {
          budget.stop("Extractor request body was not measurable; no provider call dispatched");
          throw new Error("Extractor request body admission failed");
        }
        budget.assertRequestBytes(Buffer.byteLength(init.body));
        init.signal?.throwIfAborted();
        return fetch(url, init);
      });
    }
    return {
      primaryJudge: host?.primary ?? "not-requested",
      judge(call, traces) {
        if (!host || call.arm !== "A") throw new Error("Judge arm was not admitted");
        return {
          label: host.judge.label,
          async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
            const serialized = JSON.stringify(request);
            assertSafeOutgoing(serialized);
            const requestSha256 = digest(serialized);
            // Host request bytes, not provider framing or hidden fallback-attempt bytes.
            const requestBytes = Buffer.byteLength(serialized);
            let dispatched = false;
            let returned: JudgmentResult<Q> | undefined;
            try {
              const result = await budget.run({ ...call, requestSha256, requestBytes }, options?.signal, async () => {
                dispatched = true;
                returned = await host.judge.judge(request, options);
                return returned;
              }, (value) => {
                // A catalog-priced winner is not billed spend, but an over-allowance diagnostic
                // still stops further admission. Preserve unknown billing in the failed receipt.
                const diagnostic = value.usage?.cost?.total;
                if (budget.policy && typeof diagnostic === "number" && Number.isFinite(diagnostic) && diagnostic > budget.policy.recallAllowanceUsd) {
                  budget.stop("Host winner cost diagnostic exceeded best-effort recall allowance; whole-operation billing remains unknown");
                }
                return {
                  status: "unknown",
                  // openHostJudge exposes neither all attempt receipts nor billed-vs-estimated provenance.
                  // ChainJudge returns the winning candidate; a positive winner cost cannot establish
                  // the whole operation's charge, including potentially charged fallback attempts.
                  reason: "Host winner usage can omit charged fallback attempts and contain catalog estimates; whole-operation billing is unknown",
                };
              });
              traces.push({ requestSha256, outcome: "returned", model: result.model || "unknown", usage: result.usage, answers: result.answers });
              return result;
            } catch {
              // A returned provider response can still fail budget/cancellation checks. Do not label it
              // successful before those checks settle, or recall's own fallback could hide the failure.
              traces.push({ requestSha256, outcome: dispatched ? "failed" : "blocked", model: returned?.model || "unknown",
                usage: returned?.usage ?? null, answers: returned?.answers ?? null });
              // Do not persist raw provider exceptions: they can contain credential-bearing request diagnostics.
              throw new Error(dispatched ? "Host judge operation failed" : "Judge admission blocked; no provider call dispatched");
            }
          },
        };
      },
      async extract(call, state, question, signal) {
        if (!extractor || call.arm !== "C") throw new Error("Extractor arm was not admitted");
        assertSafeOutgoing(state);
        assertSafeOutgoing(question);
        // Expose the extractor's production deadline to admission too: its internal timeout would
        // otherwise return a failed value without aborting the caller's longer-lived signal.
        const operation = AbortSignal.any([signal, AbortSignal.timeout(EXTRACT_MS)]);
        // Receipt bytes/hash bind the extractor inputs. Its exact HTTP body is independently
        // measured and refused by the transport hook above before any provider request.
        const serialized = JSON.stringify({ state, question });
        return budget.run({ ...call, requestSha256: digest(serialized), requestBytes: Buffer.byteLength(serialized) }, operation,
          () => extractor!(state, question, operation),
          (value) => value.kind === "answer" ? positiveReportedCost(value.cost, "OpenRouter extraction response usage.cost")
            : { status: "unknown", reason: "Extractor did not return positive billing information" });
      },
      close() { host?.close(); closeAuth(); },
    };
  } catch (error) { host?.close(); closeAuth(); throw error; }
}
