import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const DEFAULTS = Object.freeze({
  enabled: true,
  model: "@smol",
  nodeBytes: 512,
  viewBytes: 128_000,
  jobs: 8,
  tries: 5,
  toolCap: 30_000,
  childView: false,
  rules: true,
  prefetch: true,
  valueScore: true,
  toolGate: true,
  recall: true,
  ruleAdd: 0.8,
  prefetchK: 8,
  prefetchMin: 0.5,
  toolAsk: 0.3,
  recallMin: 0.5,
});

export interface OptChatConfig {
  enabled: boolean;
  directory: string;
  model: string;
  nodeBytes: number;
  viewBytes: number;
  jobs: number;
  tries: number;
  toolCap: number;
  childView: boolean;
  gates: GateConfig;
}

/** System One gates (Jev judgments through the host judge role), on by default. Every gate opted out means no judge is ever resolved. */
export interface GateConfig {
  rules: boolean;
  prefetch: boolean;
  valueScore: boolean;
  toolGate: boolean;
  /** Whether the recall tool may judge the view; off means the tool is not registered. */
  recall: boolean;
  /** Minimum P(rule) to add or replace a rule, in (0, 1]. */
  ruleAdd: number;
  /** Prefetch lines zoomed per turn, from 1 to 32. */
  prefetchK: number;
  /** Minimum P(relevant) for a prefetch line, in (0, 1]. */
  prefetchMin: number;
  /** Danger at or above which a tool call is confirmed or blocked, in (0, 1]. */
  toolAsk: number;
  /** Minimum P(answer) for the recall tool's first line, in (0, 1]. */
  recallMin: number;
}

type FlagReader = Pick<ExtensionAPI, "getFlag">;
type FlagRegistrar = Pick<ExtensionAPI, "registerFlag">;
type FlagValue = boolean | string | undefined;

export function registerFlags(api: FlagRegistrar): void {
  api.registerFlag("optchat", {
    type: "boolean",
    default: DEFAULTS.enabled,
    description: "Enable persistent OptChat memory (default; --no-optchat takes precedence)",
  });
  api.registerFlag("no-optchat", {
    type: "boolean",
    default: false,
    description: "Disable OptChat memory for this session, even when --optchat is present",
  });
  api.registerFlag("optchat-dir", {
    type: "string",
    description: "Private memory directory (default: one per git worktree under optchat-worktrees, else optchat, both under the OMP agent directory)",
  });
  api.registerFlag("optchat-model", {
    type: "string",
    default: DEFAULTS.model,
    description: "Compressor selector: provider/model or @role (default: @smol)",
  });
  api.registerFlag("optchat-node-bytes", {
    type: "string",
    default: String(DEFAULTS.nodeBytes),
    description: "Integer UTF-8 byte target for each summary (minimum: 64)",
  });
  api.registerFlag("optchat-view-bytes", {
    type: "string",
    default: String(DEFAULTS.viewBytes),
    description: "Integer UTF-8 byte budget for the history view (at least the summary target)",
  });
  api.registerFlag("optchat-jobs", {
    type: "string",
    default: String(DEFAULTS.jobs),
    description: "Maximum simultaneous compaction jobs, from 1 to 64",
  });
  api.registerFlag("optchat-tries", {
    type: "string",
    default: String(DEFAULTS.tries),
    description: "Shortening attempts per summary, from 1 to 100",
  });
  api.registerFlag("optchat-tool-cap", {
    type: "string",
    default: String(DEFAULTS.toolCap),
    description: "Integer character cap for ordinary tool results (minimum: 128)",
  });
  api.registerFlag("optchat-child-view", {
    type: "boolean",
    default: DEFAULTS.childView,
    description: "Give subagents a read-only frozen snapshot of this chat (zoom, date, work and chat_search only)",
  });
  for (const gate of GATE_FLAGS) {
    api.registerFlag(gate.flag, {
      type: "boolean",
      default: DEFAULTS[gate.key],
      description: `System One: ${gate.what}, judged by the judge role (default: on; --no-${gate.flag} takes precedence)`,
    });
    api.registerFlag(`no-${gate.flag}`, {
      type: "boolean",
      default: false,
      description: `Turn off the System One ${gate.name} for this session, even when --${gate.flag} is present`,
    });
  }
  api.registerFlag("optchat-rule-add", {
    type: "string",
    default: String(DEFAULTS.ruleAdd),
    description: "System One: minimum probability (0, 1] for a rule to be added or replaced (default: 0.8)",
  });
  api.registerFlag("optchat-prefetch-k", {
    type: "string",
    default: String(DEFAULTS.prefetchK),
    description: "System One: view lines zoomed per turn, from 1 to 32 (default: 8)",
  });
  api.registerFlag("optchat-prefetch-min", {
    type: "string",
    default: String(DEFAULTS.prefetchMin),
    description: "System One: minimum probability (0, 1] for a prefetched line (default: 0.5)",
  });
  api.registerFlag("optchat-tool-ask", {
    type: "string",
    default: String(DEFAULTS.toolAsk),
    description: "System One: danger probability (0, 1] at which a tool call is confirmed or blocked (default: 0.3)",
  });
  api.registerFlag("optchat-recall-min", {
    type: "string",
    default: String(DEFAULTS.recallMin),
    description: "System One: minimum probability (0, 1] for recall's first line (default: 0.5)",
  });
}

const GATE_FLAGS = [
  { key: "rules", flag: "optchat-rules", name: "rules gate", what: "keep standing user rules from messages" },
  { key: "prefetch", flag: "optchat-prefetch", name: "prefetch gate", what: "zoom view lines relevant to each new user message" },
  { key: "valueScore", flag: "optchat-value-score", name: "value-score gate", what: "give the compressor a one-sentence importance hint per leaf" },
  { key: "toolGate", flag: "optchat-tool-gate", name: "tool gate", what: "screen risky tool calls before they run" },
  { key: "recall", flag: "optchat-recall", name: "recall gate", what: "answer questions from stored history by descending the view (chat_recall tool)" },
] as const;

/** One gate: its opt-out wins over its flag; a malformed value of either fails closed. */
function gate(api: FlagReader, flag: (typeof GATE_FLAGS)[number]["flag"], fallback: boolean): boolean {
  if (boolean(api.getFlag(`no-${flag}`), `no-${flag}`, false)) return false;
  return boolean(api.getFlag(flag), flag, fallback);
}

function invalid(flag: string, requirement: string): never {
  // Flag names and requirements are static: never retain user input in diagnostics.
  throw new Error(`OptChat --${flag} ${requirement}`);
}

function boolean(value: FlagValue, flag: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return invalid(flag, "must be true or false");
}

/**
 * Whether the tool_call gate handler is registered at session start. A malformed value also registers it, so the
 * gate fails closed (every screened call is blocked) instead of silently running without the requested gate.
 */
export function toolGateRequested(api: FlagReader): boolean {
  try {
    return gate(api, "optchat-tool-gate", DEFAULTS.toolGate);
  } catch {
    return true;
  }
}

/** Read activation alone so opted-out sessions never initialize memory or model work. */
export function readEnabled(api: FlagReader): boolean {
  if (boolean(api.getFlag("no-optchat"), "no-optchat", false)) return false;
  return boolean(api.getFlag("optchat"), "optchat", DEFAULTS.enabled);
}

function integer(api: FlagReader, flag: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = api.getFlag(flag);
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0 || /[^0-9]/.test(value)) {
    return invalid(flag, `must be a decimal integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalid(flag, `must be a decimal integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function directory(value: FlagValue, fallback: string): string {
  const path = value === undefined ? fallback : value;
  if (typeof path !== "string" || !path.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(path) || !path.isWellFormed()) {
    return invalid("optchat-dir", "must be a nonempty filesystem path without control characters or invalid Unicode");
  }
  return resolve(path);
}

function compressor(value: FlagValue): string {
  if (value === undefined) return DEFAULTS.model;
  // The host splits a selector at its first slash only; model ids may hold "/", "@" and ":" (workers-ai/@cf/...).
  if (typeof value !== "string" || !/^(?:@[A-Za-z][A-Za-z0-9_-]*|[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s\u0000-\u001f\u007f-\u009f]+)$/.test(value)) {
    return invalid("optchat-model", "must be an explicit provider/model selector or @role");
  }
  return value;
}

/** A probability in (0, 1] written as a plain decimal; anything else fails closed. */
function probability(api: FlagReader, flag: string, fallback: number): number {
  const value = api.getFlag(flag);
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    return invalid(flag, "must be a decimal probability greater than 0 and at most 1");
  }
  const parsed = Number(value);
  if (!(parsed > 0 && parsed <= 1)) return invalid(flag, "must be a decimal probability greater than 0 and at most 1");
  return parsed;
}

function gates(api: FlagReader): GateConfig {
  return {
    rules: gate(api, "optchat-rules", DEFAULTS.rules),
    prefetch: gate(api, "optchat-prefetch", DEFAULTS.prefetch),
    valueScore: gate(api, "optchat-value-score", DEFAULTS.valueScore),
    toolGate: gate(api, "optchat-tool-gate", DEFAULTS.toolGate),
    recall: gate(api, "optchat-recall", DEFAULTS.recall),
    ruleAdd: probability(api, "optchat-rule-add", DEFAULTS.ruleAdd),
    prefetchK: integer(api, "optchat-prefetch-k", DEFAULTS.prefetchK, 1, 32),
    prefetchMin: probability(api, "optchat-prefetch-min", DEFAULTS.prefetchMin),
    toolAsk: probability(api, "optchat-tool-ask", DEFAULTS.toolAsk),
    recallMin: probability(api, "optchat-recall-min", DEFAULTS.recallMin),
  };
}

/** Only absent flags take defaults; malformed supplied values always fail closed. */
export function readConfig(api: FlagReader, defaultDirectory: string): OptChatConfig {
  const enabled = readEnabled(api);
  const nodeBytes = integer(api, "optchat-node-bytes", DEFAULTS.nodeBytes, 64);
  const viewBytes = integer(api, "optchat-view-bytes", DEFAULTS.viewBytes);
  if (viewBytes < nodeBytes) {
    return invalid("optchat-view-bytes", "must be at least --optchat-node-bytes");
  }
  return {
    enabled,
    directory: directory(api.getFlag("optchat-dir"), defaultDirectory),
    model: compressor(api.getFlag("optchat-model")),
    nodeBytes,
    viewBytes,
    jobs: integer(api, "optchat-jobs", DEFAULTS.jobs, 1, 64),
    tries: integer(api, "optchat-tries", DEFAULTS.tries, 1, 100),
    toolCap: integer(api, "optchat-tool-cap", DEFAULTS.toolCap, 128),
    childView: boolean(api.getFlag("optchat-child-view"), "optchat-child-view", DEFAULTS.childView),
    gates: gates(api),
  };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Nearest ancestor (or cwd itself) holding a `.git` entry: a directory, or a file for linked worktrees and submodules. */
function gitRoot(cwd: string): string | undefined {
  let directory = canonical(cwd);
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Default memory directory when --optchat-dir is absent: one per git worktree, keyed by the canonical
 * root, so concurrent worktrees never contend for one writer lease. Outside git, the global store.
 * Pure apart from filesystem lookups, runs no subprocess and never throws.
 */
export function defaultStoreDirectory(agentDirectory: string, cwd: string): string {
  const root = gitRoot(cwd);
  if (root === undefined) return join(agentDirectory, "optchat");
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 40) || "repo";
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(agentDirectory, "optchat-worktrees", `${slug}-${key}`);
}
