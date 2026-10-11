import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";

export const DEFAULTS = Object.freeze({
  enabled: true,
  model: "@smol",
  nodeBytes: 512,
  viewBytes: 128_000,
  jobs: 8,
  tries: 5,
  retryMs: 10_000,
  toolCap: 30_000,
});

export interface OptChatConfig {
  enabled: boolean;
  directory: string;
  model: string;
  nodeBytes: number;
  viewBytes: number;
  jobs: number;
  tries: number;
  retryMs: number;
  toolCap: number;
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
    description: "Private memory directory (default: optchat under the active OMP agent directory)",
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
  api.registerFlag("optchat-retry-ms", {
    type: "string",
    default: String(DEFAULTS.retryMs),
    description: "Retry delay in integer milliseconds, from 1 to 2147483647",
  });
  api.registerFlag("optchat-tool-cap", {
    type: "string",
    default: String(DEFAULTS.toolCap),
    description: "Integer character cap for ordinary tool results (minimum: 128)",
  });
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
    retryMs: integer(api, "optchat-retry-ms", DEFAULTS.retryMs, 1, 2_147_483_647),
    toolCap: integer(api, "optchat-tool-cap", DEFAULTS.toolCap, 128),
  };
}
