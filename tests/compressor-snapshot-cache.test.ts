import { expect, test } from "bun:test";
import { OPTCHAT_CACHE_RESULT_CONTRACT } from "../src/cache.ts";
import { snapshotCache } from "../evals/compressor/lib.ts";
import { anthropicModel } from "./helpers/system1-chat.ts";

const model = anthropicModel();

test("historical snapshots preserve payloads even when their fields resemble diagnostics", () => {
  const payload = { payload: "provider-owned field", mode: "provider-owned mode" };
  const snapshot = snapshotCache({ applyOptChatCache: () => payload });
  expect(snapshot.cacheReturnShape).toBe("payload");
  expect(snapshot.encodeCachePayload({}, model)).toBe(payload);
});

test("declared diagnostic snapshots expose only the encoded provider payload", () => {
  const payload = { messages: [] };
  const snapshot = snapshotCache({
    OPTCHAT_CACHE_RESULT_CONTRACT,
    applyOptChatCache: () => ({ payload, mode: "unchanged" }),
  });
  expect(snapshot.cacheReturnShape).toBe("outcome");
  expect(snapshot.encodeCachePayload({}, model)).toBe(payload);
});

test("an unknown declared snapshot contract is rejected, not treated as historical", () => {
  expect(() => snapshotCache({
    OPTCHAT_CACHE_RESULT_CONTRACT: "unknown-contract",
    applyOptChatCache: () => ({}),
  })).toThrow("Unsupported snapshot cache result contract");
});
