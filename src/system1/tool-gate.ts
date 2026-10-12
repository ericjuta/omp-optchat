import type { ChoiceAnswer, Judge, NoulAnswer, Questions } from "@oh-my-pi/pi-ai";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { utf8Prefix } from "../memory.js";
import { boundedGateError, judgeWithin } from "./judge.js";

/** Wall bound for one screening judgment. */
export const TOOL_GATE_MS = 8_000;
/** The input JSON the judge sees, in characters. */
export const TOOL_INPUT_CHARS = 8_000;

/** Tools that cannot change the outside world, or that are OptChat's own. Never screened. */
export const EXEMPT_TOOLS: Record<string, true> = {
  zoom: true,
  date: true,
  work: true,
  chat_search: true,
  chat_recall: true,
  read: true,
  grep: true,
  glob: true,
  find: true,
  todo: true,
  ask: true,
  think: true,
  web_search: true,
};

/** Only what the gate needs from the host: whether a user can answer, and how to ask. */
export interface GateUi {
  readonly hasUI: boolean;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface GateCall {
  readonly toolName: string;
  readonly input: unknown;
  readonly cwd: string;
}

/** `allowed`: the call ran. `asked`: a confirm dialog was shown. `blocked`: the call did not run. */
export type GateOutcome = "allowed" | "asked" | "blocked";

export interface GateOptions {
  readonly judge: Judge | undefined;
  readonly toolAsk: number;
  readonly ui: GateUi;
  readonly timeoutMs?: number;
  /** Receives a bounded reason whenever the judge could not screen a call. */
  readonly report?: (failure: string) => void;
  /** Receives the outcome of each screened call, once it is decided. */
  readonly outcome?: (outcome: GateOutcome) => void;
}

const QUESTIONS: Questions = {
  risk: {
    type: "choice",
    instructions: "How risky is this tool call for the user's files, data, or outside systems?",
    criteria: {
      safe: "reads or changes nothing that matters",
      risky: "changes something the user may want to keep, but is recoverable",
      destructive: "cannot be undone easily",
    },
  },
  deletes: {
    type: "noul",
    instructions: "The call deletes, overwrites, or truncates files or data.",
  },
  remote: {
    type: "noul",
    instructions: "The call downloads and runs remote code, or sends data to an outside service.",
  },
  shared: {
    type: "noul",
    instructions: "The call acts on production, shared, or remote systems: deploys, pushes, publishes, or migrations.",
  },
};

/** The call's danger: the largest of destructive, deletes, remote, and shared. */
export function dangerOf(risk: ChoiceAnswer<string>, deletes: NoulAnswer, remote: NoulAnswer, shared: NoulAnswer): number {
  return Math.max(risk.probabilities.destructive ?? 0, deletes.noul, remote.noul, shared.noul);
}

/** The first `cap` UTF-16 units, never ending on a lone high surrogate. */
function capChars(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const high = text.charCodeAt(cap - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? cap - 1 : cap);
}

function summaryOf(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    text = "";
  }
  return utf8Prefix(text.replace(/\s+/g, " "), 200);
}

/**
 * The decision for one tool call, or undefined to let it run. Danger at or above `toolAsk` asks the user when
 * there is a UI and blocks otherwise. A judge failure fails closed the same way. Never throws.
 */
export async function gateToolCall(call: GateCall, options: GateOptions): Promise<ToolCallEventResult | undefined> {
  if (Object.hasOwn(EXEMPT_TOOLS, call.toolName)) return undefined;
  const failure = await screen(call, options);
  if (failure.kind === "judged" && failure.danger < options.toolAsk) {
    options.outcome?.("allowed");
    return undefined;
  }
  if (failure.kind === "failed") options.report?.(failure.error);
  const reason = failure.kind === "judged"
    ? `danger ${failure.danger.toFixed(2)} is at or above ${options.toolAsk.toFixed(2)}`
    : `the judge failed (${failure.error})`;
  if (!options.ui.hasUI) {
    options.outcome?.("blocked");
    return { block: true, reason: `OptChat tool gate blocked ${call.toolName}: ${reason}; no UI to confirm.` };
  }
  options.outcome?.("asked");
  let approved: boolean;
  try {
    approved = await options.ui.confirm(
      `OptChat tool gate: ${call.toolName}`,
      `${reason}.\nInput: ${summaryOf(call.input)}\nAllow this call?`,
    );
  } catch (error) {
    options.outcome?.("blocked");
    return { block: true, reason: `OptChat tool gate blocked ${call.toolName}: confirmation failed (${boundedGateError(error)}).` };
  }
  options.outcome?.(approved ? "allowed" : "blocked");
  return approved ? undefined : { block: true, reason: `OptChat tool gate: ${call.toolName} was declined (${reason}).` };
}

type Screen = { readonly kind: "judged"; readonly danger: number } | { readonly kind: "failed"; readonly error: string };

async function screen(call: GateCall, options: GateOptions): Promise<Screen> {
  const judge = options.judge;
  if (!judge) return { kind: "failed", error: "no judge candidate" };
  try {
    // Inside the try: a non-serializable input (cycle, BigInt) is a judge failure, never a throw.
    const input = capChars(JSON.stringify(call.input) ?? "null", TOOL_INPUT_CHARS);
    const state = { tool: call.toolName, input, cwd: call.cwd };
    const result = await judgeWithin(judge, { state, questions: QUESTIONS }, options.timeoutMs ?? TOOL_GATE_MS);
    const danger = dangerOf(
      result.answers.risk as ChoiceAnswer<string>,
      result.answers.deletes as NoulAnswer,
      result.answers.remote as NoulAnswer,
      result.answers.shared as NoulAnswer,
    );
    return { kind: "judged", danger };
  } catch (error) {
    return { kind: "failed", error: boundedGateError(error) };
  }
}
