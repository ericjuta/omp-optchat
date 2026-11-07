/** Screening flags are private review blockers, not a claim that a string is an active credential. */
export interface SecretFlag { readonly format: string; readonly offset: number }
const formats: readonly [string, RegExp][] = [
  ["private-key-block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ["openrouter-key", /\bsk-or-v1-[a-fA-F0-9]{32,}\b/g],
  ["openai-style-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["jwt-shaped-token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g],
  ["credential-url-userinfo", /https?:\/\/[^\s/@:"'<>\\{}?#]+:[^\s/@"'<>\\{}?#]{8,}@/g],
  ["credential-assignment", /\b(?:[A-Z_]*(?:API_KEY|SECRET_ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN)|Authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?[A-Za-z0-9_+/.=-]{24,}/g],
];
export const PRIVACY_SCREEN = "known-credential-formats-v1; full frozen messages/summaries/questions and each outgoing request; flags block, never redact";
export function secretFlags(value: string): SecretFlag[] {
  const flags: SecretFlag[] = [];
  for (const [format, expression] of formats) {
    expression.lastIndex = 0;
    for (const match of value.matchAll(expression)) {
      flags.push({ format, offset: match.index! });
      if (flags.length === 256) return flags;
    }
  }
  return flags;
}
export function assertSafeOutgoing(value: string): void {
  if (secretFlags(value).length) throw new Error("Outgoing text has a credential-format review flag; paid call blocked, no source bytes redacted");
}
