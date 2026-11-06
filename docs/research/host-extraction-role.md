# Host extraction role for Clairic spans (2026-11-06)

Research ticket #19 (map #18). Question: what is the smallest host-side interface that lets OptChat call a typed span extractor (Cloudflare Clairic) without a provider client in the plugin? Does the current host already have one? How do Clairic character offsets map to OptChat UTF-8 byte offsets? Should the patch stay source-only or go upstream?

Each claim carries one tag: **runtime-observed** (run in this session; output recorded), **source-read** (path:line or URL), or **[INFERENCE]** (with its basis). Path prefixes:

- `V/` = `node_modules/@oh-my-pi/` in this repo (host 18.10.3, vendored).
- `H/` = `packages/` in a local oh-my-pi source checkout at `45c35e4` (18.12.6), carrying the uncommitted collab patch; read only.
- `U/` = upstream `can1357/oh-my-pi` tag `v18.17.0` (commit `75e7801e247d4e3263439d4cc08ccad60dc64bdd`), shallow-cloned read-only to `/tmp/omp-upstream-18.17.0/packages/`.

## Answer

1. **No host version has extraction.** 18.10.3, 18.12.6, 18.13.3 and the latest tag 18.17.0 serve only finite judgments; there is no `extract` kind, role, runner API or Clairic model. See "Current host" below.
2. **Smallest interface:** a new model kind `extract`, a runner API `workers-ai-clairic`, a catalog seed for `@cf/cloudflare/clairic`, a built-in `extract` role, a `NativeExtractor` in `pi-ai/src/extraction/`, and `resolveExtractor()` exported from `@oh-my-pi/pi-coding-agent/extraction`. Together they mirror the judge path at about one third of its size. The host returns spans already **verified and normalized to UTF-16 code units of the caller's text**. The plugin maps them to UTF-8 bytes and checks them again. See "Proposed interface".
3. **Offsets:** Clairic's offset unit is undocumented (code points or UTF-16 units). The host has to detect it per span by checking the slice against `guess`, and must not search for the text, because repeated text would be ambiguous. Redaction in upstream judgment rewrites state before sending (as of 18.17.0). An extractor that redacts must map spans back through its edit log, and a span that overlaps an edit becomes null. See "Offset mapping".
4. **Recommendation: upstream, built on v18.17.0.** A source-only patch would not run. The installed host is a compiled 18.17.0 binary that serves plugin imports from its own packages, while the source-only base is 18.12.6. The change only adds code, and it reuses the Workers AI auth, wire and role machinery that upstream already owns. Until it lands, the plugin develops against a fake and loads the module with a feature check. See "Source-only or upstream".

## Current host: judgment only

- 18.10.3 (vendored): `JUDGMENT_WIRES` maps `typesafe`, `openrouter-decisions`, `workers-ai-systemone`, `openai-decisions` to judgment wires. **source-read** `V/pi-ai/src/judgment/native.ts:46-51`. `workersAiWire` serves "decision models (Clef)". **source-read** `V/pi-ai/src/judgment/systemone.ts:47-48`.
- 18.12.6: same four wires. **source-read** `H/ai/src/judgment/native.ts:49-54`. A `Question` is one of `choice`, `noul`, `score` or `box`. There is no span or text answer. **source-read** `H/ai/src/judgment/types.ts:24-57`. The catalog's `MODEL_KINDS` are `chat, tiny, image, tts, stt, search, judge, embedding, rerank, video`, and `workers-ai-systemone` maps to kind `judge`. **source-read** `H/catalog/src/types.ts:29-40,66-71`. The Workers AI catalog seeds only `@cf/cloudflare/clef` and `clef-flash`, and `models "*" { kind "judge" }` applies to every model of the provider. **source-read** `H/catalog/src/compat/rules/providers/cloudflare-workers-ai.kdl:14-33`.
- 18.13.3: `RUNNER_API_KINDS` still maps `workers-ai-systemone` to `judge`, and `types.ts` has no `clairic` or `extract` entry. **source-read** (via `gh api …/contents/packages/catalog/src/types.ts?ref=v18.13.3`, lines 55, 71).
- 18.17.0 (latest release, 2026-11-06T05:12:54Z): `grep -rni clairic packages` returns nothing. `KIND_ROLE_IDS` is still `["image","web","speech","dictation","judge"]`, the kinds and runner APIs are unchanged, and the Workers AI seed is still Clef only. **runtime-observed** (grep over `U/`; `gh release list` output) and **source-read** `U/tui/src/overlays/model-browser.ts:109`, `U/catalog/src/types.ts:30-82`. The ai, coding-agent and catalog CHANGELOGs mention extraction only in unrelated senses (memory extraction, `reasoning_extraction` refusals, PDF text). **runtime-observed** (grep).
- The installed host is `omp/18.17.0`. **runtime-observed** (`omp --version`).
- Judgment changed between 18.12.6 and 18.17.0. Native judgment now redacts credentials in `state` before encoding (`redactSensitiveInObject(request.state)`). It also adds `extraBody` and an inference User-Agent. **runtime-observed** (`diff -r H/ai/src/judgment U/ai/src/judgment`) and **source-read** `U/ai/src/judgment/native.ts:366-368`.

## Judgment design to mirror

- **Request and result.** `JudgmentRequest {state, questions, images?}` and `JudgmentResult {api, provider, model, answers, usage}`, with answers typed per question through a conditional type. **source-read** `H/ai/src/judgment/types.ts:116-129`. `Judge` is `{label, supportsImages?, judge(request, options?)}`, documented as stateless and shareable. **source-read** `H/ai/src/judgment/types.ts:136-143`.
- **Wire seam.** `JudgmentWire {target(baseUrl, model, key), encode, decode}`, with dialects defined per API. **source-read** `H/ai/src/judgment/wire.ts:31-52`. The Workers AI target resolves `<account>` from the stored Cloudflare credential, falling back to `CLOUDFLARE_ACCOUNT_ID`. The body names the model by its last path segment, and decoding unwraps `{result}`. **source-read** `H/ai/src/judgment/systemone.ts:181-209`. Credentials are parsed by `parseCloudflareCredential` (token, optional `accountId`, `gatewayId`). **source-read** `H/catalog/src/wire/cloudflare.ts:11-30`. The env fallback is `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_AUTH_TOKEN`. **source-read** `cloudflare-workers-ai.kdl:10`.
- **Transport.** `NativeJudge` takes an injectable `fetch?: FetchImpl` (**source-read** `H/ai/src/judgment/native.ts:170`). It rotates keys through `withAuth` (`:459`), retries 408, 429 and 5xx up to 3 attempts with `retry-after`-aware backoff (`:495-534`), and uses a 10 s per-attempt timeout (`:215`). A missing or mistyped answer for any question becomes `ProviderResponseError` (`:467-484`). **source-read**.
- **Role chain.** `resolveJudge(deps)` returns a `ChainJudge` that walks `resolveRoleChain("judge", settings, roleCandidatePool("judge", …))`, cached for 1 s. **source-read** `H/coding-agent/src/judgment/index.ts:179-200,354-356`. After the first native candidate, prompted models are dropped: "a prompted model never stands in for a failed native judgment" (`:246-255`). Accounts that answer 401, 402 or 403 are skipped for 5 min (`:149`, `:467-468`, `:700-703`). Abort and timeout are rethrown, not failed over (`:463-466`). **source-read**.
- **Credentials stay in the host.** `#createJudge` checks `registry.getApiKey(model, sessionId)`, then passes `registry.resolver(model, sessionId)` (an `ApiKey`, not a string) and `resolveModelHeaders` into `createNativeJudge`. **source-read** `H/coding-agent/src/judgment/index.ts:532-541`. The plugin only ever holds a `Judge`. **source-read** `src/system1/judge.ts:25-44`.
- **Cost.** A response without a billed amount is priced from the catalog with `calculateCost(model, usage)`. Every attempt, failures included, is reported once through `onUsage`, and `journalJudgmentUsage` writes it as a `model_usage` session entry. **source-read** `H/coding-agent/src/judgment/index.ts:604-697,130-138`; `H/coding-agent/src/session/session-manager.ts:3466-3488`. `ModelUsageEntry.role` is a free `string`. **source-read** `U/coding-agent/src/session/session-entries.ts:121-124`.
- **Roles.** A role is a `ModelRole` union member, plus a `MODEL_ROLES` entry with an `accepts(model)` predicate, plus membership in `KIND_ROLE_IDS`. **source-read** `U/tui/src/overlays/model-browser.ts:61-77,109`; `H/coding-agent/src/config/model-roles.ts:51-54,90`. Per-model `models "<id>" { kind "…" }` selectors already exist, for example OpenRouter's rerank, embedding, video and stt rows. **source-read** `U/catalog/src/compat/rules/providers/openrouter.kdl:140-151`.
- **How the plugin reaches the host.** OptChat imports `resolveJudge` from `@oh-my-pi/pi-coding-agent/judgment` (**source-read** `src/system1/judge.ts:3`), a package export (**source-read** `H/coding-agent/package.json:340-343`). Compiled binaries serve plugin imports of host packages through `omp-legacy-pi-bundled:<key>` virtual modules, derived "from current package exports". **source-read** `U/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts:21-37`. So at runtime the plugin runs the host's code and the host's credentials. A new surface needs a new package export. A static import of a missing export fails at plugin load. [INFERENCE] from the same lines, and from the local skill `omp-plugin-missing-host-export` ("Export named 'X' not found in module 'omp-legacy-pi-bundled'").

## What Clairic accepts and returns

- **Request.** Body `{model, state: string, fields, images?, reference_date?, options?}`. `model` matches `^(clairic|@cf/cloudflare/clairic)$`. `state` is a **string only**: "Text answers are spans of this string." Field names match `^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$`. Field types are `text|number|date|time|datetime|duration|list|estimate|forecast`. A list needs `items` of `text|number|date`. `null_threshold` defaults to 0.5. `options.return_state_text` means "Return the text that spans index into". Images: at most 4. The request body is capped at 16 MiB. **source-read** https://developers.cloudflare.com/workers-ai/models/clairic/schema-input.json.
- **Response.** `{model, answers, truncated, state_text?, usage{state_tokens, image_tokens, schema_tokens, input_tokens, output_tokens, passes}}`. Each answer has `type`, `value`, `guess`, `p_null`, `confidence`, and either `span: int[]` or `spans: int[][]`. **source-read** schema-output.json (same path). The offset unit is **not stated** anywhere: the schema says `integer`, and the page and blog say "character offsets". **source-read** https://developers.cloudflare.com/workers-ai/models/clairic/ and https://blog.cloudflare.com/clairic-extraction-model/.
- **Null answers keep a span.** In the docs example, `po_number` has `value: null`, `p_null: 1`, `guess: "INV-2291"` and `span: [8, 16]`. So a span locates the **guess**, and a null value still carries one. **source-read** (docs example response).
- **Spans are half-open.** In that example, `state.slice(8,16) === "INV-2291"`, `slice(120,129) === "Dana Ruiz"` and `slice(131,141) === "Priya Shah"`. The example is pure ASCII, so it cannot tell code points from UTF-16 units. **runtime-observed** (Bun eval).
- **Context and price.** 65,536-token context; fields that do not fit beside the state in one 8,192-token pass are split across parallel passes. $0.10 per million input tokens, no output charge. **source-read** (model page).
- **Reachability.** Through a Workers AI binding or `POST /client/v4/accounts/{id}/ai/run/@cf/cloudflare/clairic` with a bearer token. This is the same route shape and credential as Clef. **source-read** (model page; `systemone.ts:181-209`).

## Proposed interface (host)

All new code is additive. Nothing in the judge path changes.

### Catalog (`pi-catalog`)

- `MODEL_KINDS` gains `"extract"`. `RUNNER_APIS` gains `"workers-ai-clairic"`, and `RUNNER_API_KINDS["workers-ai-clairic"] = "extract"`.
- `cloudflare-workers-ai.kdl` gains a second seed:

```kdl
seed api="workers-ai-clairic" base-url="https://api.cloudflare.com/client/v4/accounts/<account>/ai/run" bundle="always" {
	model "@cf/cloudflare/clairic" name="Clairic" {
		reasoning #false
		input "text"
		cost input=0.10 output=0 cache-read=0 cache-write=0
		limits context=65536
		supports-tools #false
	}
}
models "@cf/cloudflare/clairic" { kind "extract" }
```

  The catch-all `models "*" { kind "judge" }` must then stop matching Clairic, either through an explicit selector that takes precedence or by narrowing the catch-all to `@cf/cloudflare/clef*`. [INFERENCE] The precedence rules of KDL selectors were not read. Images stay out of v1: OptChat extracts from stored text. [INFERENCE]

### Role (`pi-tui` model-browser, `coding-agent` model-roles)

- `ModelRole` gains `"extract"`. `KIND_ROLE_IDS` gains `"extract"`. `MODEL_ROLES.extract = { tag: "EXTRACT", name: "Extraction", color: "muted", section: "kind", accepts: m => modelKind(m) === "extract" }`.
- Unlike `judge`, the role accepts **only** native extractors. A chat model cannot return a calibrated `p_null` or offsets that index into the input. This follows the judge rule that a prompted model never stands in for a native one (`index.ts:246-255`). There is no session-model fallback. [INFERENCE]
- The default role priority for `extract` is `cloudflare-workers-ai/@cf/cloudflare/clairic`, added through `roleDefaultModels()`, which `rolePriorityDefaults` reads (**source-read** `U/coding-agent/src/config/model-resolver.ts:1208-1213`). Users override it the usual way (`modelRoles.extract`, `@extract`).

### Types (`pi-ai/src/extraction/types.ts`)

```ts
import type { Usage } from "../types";

/** One text span of the request's `text`: half-open, in UTF-16 code units, verified by the host. */
export interface TextSpan { readonly start: number; readonly end: number }

/** A field whose answer is one exact span of the text. */
export interface TextField { type: "text"; instructions?: string; nullThreshold?: number }
/** A field whose answer is every matching span of the text, in input order. */
export interface TextListField { type: "list"; items: "text"; instructions?: string }
export type ExtractionField = TextField | TextListField;
/** Keys match ^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$ (Clairic's propertyNames); answers come back under the same keys. */
export type ExtractionFields = Record<string, ExtractionField>;

export interface TextExtraction {
	type: "text";
	/** The span's text when the input settles the field; null when it does not. */
	value: string | null;
	/** What the model would pick regardless; null only when the wire returned none. */
	guess: string | null;
	/** Probability the field has no answer in the text, 0–1. */
	pNull: number;
	confidence: number;
	/** Location of `guess` in `text`, or null when the host could not verify it (see Offset mapping). */
	span: TextSpan | null;
}
export interface TextListExtraction {
	type: "list";
	/** Each item with its verified span; unverifiable items are dropped and counted. */
	items: readonly { value: string; span: TextSpan }[];
	droppedItems: number;
	confidence: number;
}
export type ExtractionFor<F extends ExtractionField> = F extends TextListField ? TextListExtraction : TextExtraction;

export interface ExtractionRequest<F extends ExtractionFields = ExtractionFields> {
	/** The exact text spans index into. Non-empty. */
	text: string;
	fields: F;
	/** ISO date anchoring year-less dates; unused by text fields, passed through. */
	referenceDate?: string;
}

export interface ExtractionResult<F extends ExtractionFields = ExtractionFields> {
	api: string;
	provider: string;
	model: string;
	answers: { [K in keyof F]: ExtractionFor<F[K]> };
	/** The provider cut the text; a null `value` may mean "not read", not "absent". */
	truncated: boolean;
	usage: Usage;
	/** Where `usage.cost` came from; "unknown" when neither the wire nor the catalog priced it. */
	costSource: "reported" | "catalog" | "unknown";
}

export interface ExtractOptions { signal?: AbortSignal }

/** Extracts typed spans from a text. Stateless and safe to share, like Judge. */
export interface Extractor {
	readonly label: string;
	extract<F extends ExtractionFields>(request: ExtractionRequest<F>, options?: ExtractOptions): Promise<ExtractionResult<F>>;
}
```

Why these choices:
- Only `text` and `list<text>` are in scope, because OptChat needs evidence spans. Numbers, dates, estimates and forecasts can be added later as further union members without breaking callers. [INFERENCE]
- `text: string` rather than `JudgmentState`, because Clairic spans index into a string state only (schema-input above).
- `costSource` exists because AGENTS.md:43 requires unknown cost to be recorded as `unknown`, never as zero. `tokenUsage` turns a missing cost into 0 (**source-read** `H/ai/src/judgment/types.ts:163-175`), and that loses the difference.

### Native client (`pi-ai/src/extraction/native.ts`)

```ts
export interface NativeExtractorOptions {
	apiKey: ApiKey;              // from registry.resolver(); rotated by withAuth like NativeJudge
	baseUrl: string;             // catalog base URL with <account>
	model: string;               // wire id, e.g. "@cf/cloudflare/clairic"
	provider: string;            // "cloudflare-workers-ai"
	headers?: Record<string, string>;
	fetch?: FetchImpl;           // test seam, as NativeJudge (native.ts:170)
	timeoutMs?: number;          // default 10_000, as DEFAULT_TIMEOUT_MS
}
export class NativeExtractor implements Extractor { /* … */ }
export function createNativeExtractor(model: Model, connection: NativeJudgeConnection): NativeExtractor;
export function isExtractionApi(api: Api): api is "workers-ai-clairic";
```

Behavior. Every point except the last mirrors `NativeJudge` (**source-read** `H/ai/src/judgment/native.ts:451-534`); the last is new.
- Reuse the `workersAiWire.target` logic for the account and token, and `withAuth` for key rotation.
- Retry the same transient statuses.
- Encode `{model: "clairic", state, fields, reference_date?, options: {return_state_text: true}}`. Map `nullThreshold` to `null_threshold`.
- Decode `{result}`. Reject a missing or mistyped answer for any field as an `envelope` `ProviderResponseError`.
- Then **verify every span** (next section) before returning. No partial results: a request either returns an answer for every field or throws, as `#judgeOnce` does.

### Role chain (`coding-agent/src/extraction/index.ts`, export `./extraction`)

```ts
export interface ExtractorDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId?: string;
	/** Why the extraction runs; labels ledger entries. */
	purpose: string;
	/** Every billed attempt exactly once, failures included. */
	onUsage?: (usage: JudgmentUsage) => void; // same record shape; role "extract"
	telemetry?: AgentTelemetryConfig;
}
export function resolveExtractor(deps: ExtractorDeps): ChainExtractor;
export function hasExtractor(settings: Settings, registry: ModelRegistry): boolean;
export class ChainExtractor implements Extractor {
	readonly label = "extract role chain";
	primaryModel(): Model | undefined;
	extract<F extends ExtractionFields>(request: ExtractionRequest<F>, options?: ExtractOptions): Promise<ExtractionResult<F>>;
}
```

The chain reuses `resolveRoleChain("extract", …)`, the 1 s chain cache, the 5-minute account-rejection cooldown and the abort rules from `ChainJudge` (`index.ts:149,179-200,423-489`). If `JudgmentUsage` is reused for the ledger, `journalJudgmentUsage` works unchanged; it only needs a neutral alias name. There is no answer cache in v1: extraction inputs are whole messages, so repeats are rare. [INFERENCE] The plugin receives an `Extractor` object and never sees a token, account id or URL.

### Fakes

- **Host tests:** inject `fetch` into `NativeExtractor` and return canned Workers AI envelopes `{result: {model, answers, truncated, state_text, usage}, success: true, errors: []}`. This mirrors how `NativeJudge` is tested with an injected `fetch` (**source-read** `native.ts:170,343`). Cases: an ASCII span, the code-point/UTF-16 divergence, a `state_text` mismatch, `truncated: true`, 401 then rotation, 429 then retry, a malformed envelope, and a missing field.
- **Plugin tests:** add `OptChatOptions.extractor?: ExtractorFactory`, with `type ExtractorFactory = (ctx: ExtractionContext, purpose: string) => Extractor | undefined`, beside the existing `judge?: JudgeFactory` (**source-read** `src/index.ts:162,705,2229`; AGENTS.md:41 "Tests inject a fake judge through `OptChatOptions.judge`"). A test fake is a plain object:

```ts
export function fakeExtractor(answer: (req: ExtractionRequest) => ExtractionResult["answers"], cost = 0): Extractor & { calls: ExtractionRequest[] } {
	const calls: ExtractionRequest[] = [];
	return {
		label: "fake/extract",
		calls,
		async extract(request) {
			calls.push(request);
			return { api: "fake", provider: "fake", model: "fake", answers: answer(request) as never, truncated: false,
				usage: tokenUsage(request.text.length, 0, cost), costSource: "reported" };
		},
	};
}
```

  The plugin loads the host module with `await import("@oh-my-pi/pi-coding-agent/extraction").catch(() => undefined)`. When the module is absent, the gate is inactive with a status reason, instead of failing plugin load. [INFERENCE] Whether a dynamic import of a missing virtual export rejects cleanly, rather than throwing at link time, is unverified.

### Cost reporting

- Clairic's usage reports `input_tokens` and `output_tokens: 0`, with no USD amount. **source-read** (docs example, schema-output). The host prices it with `calculateCost(model, usage)` against the catalog cost `input=0.10` and sets `costSource: "catalog"`. If the catalog row has no price, it sets `"unknown"`. If a gateway reports a `cost`, it sets `"reported"`.
- Each attempt goes to `onUsage` with `role: "extract"` and the caller's `purpose`, so `journalJudgmentUsage` / `appendModelUsage` count it in session totals (**source-read** `session-manager.ts:3466-3488`). Telemetry needs either an extraction span or a generic span with `purpose`. The judgment span helper is `recordJudgmentTelemetry` (**source-read** `H/agent/src/telemetry.ts:1714`). [INFERENCE] Whether reusing it is acceptable upstream has not been checked.
- OptChat writes the result's `usage.cost.total` and `costSource` into `metrics.jsonl`. `"unknown"` stays `"unknown"` (AGENTS.md:43).

## Offset mapping

There are three coordinate systems:
1. **W**: Clairic's wire offsets into `state_text`. The unit is undocumented: code points if the server indexes Python `str`, UTF-16 units if it indexes JS strings. [INFERENCE]
2. **U**: UTF-16 code units of the caller's `text`. This is the host's contract.
3. **B**: UTF-8 bytes of OptChat's stored message text. This is the unit of `zoom(id, 1, offset)` and `work(name, offset)` pages (**source-read** `src/handoff.ts:167,237`). `readTextPage` requires offsets on a code-point boundary (**source-read** `src/archive.ts:59-98`).

### Host: W to U (`verifySpans`)

The host runs these steps for each answer, in order.

1. **Redaction log.** If the host redacts the text before sending, as 18.17.0 does for judgment state (**source-read** `U/ai/src/judgment/native.ts:366-368`), it must redact with an edit log `[{start, end, replacementLength}]` in U units. Today `redactSensitiveCredentials` uses `String.replace` with fixed labels such as `[github_token_redacted]`, which are not length-preserving and keep no log (**source-read** `U/ai/src/providers/transform-messages.ts:739-758`). A `redactWithEdits(text)` sibling can build the log from the replace callback's offset argument. [INFERENCE] Call the sent text S.
2. **State text.** Send `return_state_text: true`. If `state_text` is present and `state_text !== S`, the server changed the text (normalization or truncation). If `S.startsWith(state_text)` (truncation only), keep going. Otherwise every span becomes `null`. [INFERENCE] Whether Clairic normalizes text is undocumented; the check makes the answer not matter.
3. **Unit detection, per span.** Given wire `[a, b)` and `guess` g:
   - `u = S.slice(a, b)`, read as UTF-16 units.
   - `c = S.slice(cpToU(S, a), cpToU(S, b))`, read as code points, where `cpToU` walks `codePointAt` and steps 2 units for each astral character.
   - The span is accepted if exactly one reading equals g, or if both do (they agree when no astral character precedes the end), and its U-unit pair is used.
   - If neither reading equals g, the span becomes `null`.
   - **Never** fall back to `S.indexOf(g)`: with repeated text it can return a different occurrence than the one the model pointed at.
   - A span with `a > b`, a negative or non-integer bound, or a bound past `S.length`, is `null`.
4. **Undo redaction.** Map S coordinates back to the caller's text through the edit log. A span that overlaps any edit becomes `null`, because its text was never what the user wrote.
5. **Lists.** Apply steps 3 and 4 to each `spans[i]` against `value[i]`. Drop items that fail and count them in `droppedItems`.

The divergence is real. For `"😀 café 😀 café"` the second `café` starts at UTF-16 unit 11, code point 9 and UTF-8 byte 16, and ends at byte 21. Slicing UTF-16 with the code-point offset gives the garbage `"\ude00 ca"`. **runtime-observed** (Bun eval: `{u16: 11, cp: 9, b: 16, byteEnd: 21}`, `sliceByCpAsU16: '\ude00 ca'`).

### Plugin: U to B

```ts
/** UTF-8 byte offset of UTF-16 index `u` in `text`; throws inside a surrogate pair. */
export function utf16ToUtf8(text: string, u: number): number;
/** Byte span [start, end) of a verified UTF-16 span, plus a check that the bytes decode to `expected`. */
export function byteSpan(text: string, span: TextSpan, expected: string): { start: number; end: number } | null;
```

- Walk code points with the same `utf8Width` and checkpoint index as `readTextPage` (**source-read** `src/archive.ts:29-52`), so evidence offsets always line up with zoom pages.
- A lone surrogate counts 3 bytes, because `TextEncoder` writes U+FFFD for it. **runtime-observed**: `"a\uD800b"` encodes to 5 bytes. The width function returns 3 for 0xD800, which agrees. **source-read** `src/archive.ts:29`.
- Re-verify: `decode(encode(text).subarray(start, end)) === expected`. Otherwise return `null`, so code keeps the authority rather than the model or the host (AGENTS.md:41-43 spirit). A span that contains a lone surrogate fails this check (U+FFFD ≠ original) and is dropped. That is correct, because such a span could not round-trip through a UTF-8 page.
- When the plugin sends a window of a long message, it adds the window's base byte offset to the result. The base must lie on a code-point boundary, and `readTextPage` already enforces that.

### Test cases

Host (`verifySpans`) and plugin (`utf16ToUtf8`, `byteSpan`) each need these:

| # | Text and span | Expected |
|---|---|---|
| 1 | Docs example, ASCII, `[8,16]` = `INV-2291` | Both units agree; U `[8,16]`, B `[8,16]` |
| 2 | 2-byte Latin: `"naïve café"`, span over `café` | U = code point; B shifted by +1 for `ï` |
| 3 | 3-byte CJK before the span: `"東京 Tokyo"`, span `Tokyo` | U `[3,8]`, B `[7,12]` |
| 4 | Astral emoji before the span: `"😀 café 😀 café"`, second `café` | Wire cp `[9,13]` → U `[11,15]` → B `[16,21]`; a UTF-16 wire `[11,15]` also resolves; garbage slice rejected |
| 5 | Emoji inside the span: `"see 👍🏽 ok"`, span `👍🏽` (surrogate pairs plus a modifier) | U length 4, B length 8; both bounds on code-point boundaries |
| 6 | Repeated text: `"id 42 … id 42"`, wire points at the 2nd | 2nd occurrence returned; a test asserts `indexOf` would return the 1st |
| 7 | Repeated text, wire bounds slice a different string | `span: null`, no search fallback |
| 8 | NFD `"cafe\u0301"` (5 units) vs NFC `"café"` (4) | `state_text` differs → all spans null; **runtime-observed** lengths 5 vs 4 |
| 9 | `truncated: true` with `state_text` a prefix of S | Spans inside the prefix kept; `truncated` surfaced; null values not admitted as absent |
| 10 | Redaction: `"key ghp_… then INV-1"` | Span after the edit shifted back correctly; a span overlapping the token is null |
| 11 | Lone surrogate inside the span: `"a\uD800b"` | Host U span valid; plugin `byteSpan` null (U+FFFD mismatch) |
| 12 | Lone surrogate before the span | B offset counts 3 bytes for it, matching `TextEncoder` |
| 13 | Bound inside a surrogate pair (U index between high and low) | `utf16ToUtf8` throws; host already rejected it |
| 14 | `value: null` with a span (docs `po_number`) | `span` locates `guess`; the plugin does not admit it as evidence |
| 15 | Empty span `[k,k]`, reversed span, negative bound, bound > length, non-integer | `null` |
| 16 | List field, one valid item and one bad item | One item kept, `droppedItems: 1` |
| 17 | Window offset: span inside a window starting at byte 4096 of a multibyte message | B = 4096 + local; `readTextPage(text, B)` succeeds and starts with the span |
| 18 | CRLF and tab in the text | Counted as 1 unit / 1 byte each; JSON transport preserves them |

## Source-only or upstream

Recommendation: **upstream**, against `v18.17.0`, not the 18.12.6 checkout.

- **A source-only patch would not run.** The installed host is the compiled 18.17.0 binary (**runtime-observed**), and it serves plugin imports from its own bundled packages (**source-read** `legacy-pi-compat.ts:21-37`). A source-only patch takes effect only when someone runs the patched checkout. The v0.14.0 collab patch is the precedent: verified, but uncommitted, unpublished and not installed (project history, source: the 0.14.0 release notes recorded in this session's memory; not re-verified).
- **The base has drifted.** The source-only checkout is 18.12.6 (**runtime-observed** `git log -1`: `45c35e4 chore: bump version to 18.12.6`) and is five minor releases behind. Upstream judgment has changed in that interval: redaction, `extraBody`, User-Agent (**runtime-observed** diff). A patch on 18.12.6 would need a rebase before anyone could install it. [INFERENCE]
- **Upstream already owns every dependency.** That covers Workers AI login and credential parsing, the account-scoped route, `withAuth`, role chains, the catalog kinds and runner APIs, and session cost journaling (all **source-read** above). Upstream also accepts outside judgment features through PRs: the ai CHANGELOG credits Workers AI and OpenAI Decisions images to `@anatoli-tsinovoy` (#15471). **source-read** `U/ai/CHANGELOG.md:233`.
- **The change is additive and generic.** It adds a new kind, API, role and module. Existing judge users see no change. Clairic is a public model, not an OptChat-specific service. [INFERENCE]
- **Risks.** Clairic is a preview model (**source-read**, model page), and upstream acceptance is not guaranteed. [INFERENCE] Mitigation: the plugin's evidence layer is built and tested against the fake, ships with the extract gate off, and the feature-checked import keeps older hosts working.

## Gaps

- **Offset unit.** Code points or UTF-16 units is undocumented. Settling it needs one live Clairic call with an astral character before the span. That call is paid, needs a Cloudflare credential, and per AGENTS.md needs a pre-registered budget, so it was not run. The host design detects the unit per span either way.
- **Normalization.** Whether Clairic normalizes `state` (NFC, whitespace) or returns `state_text` only when asked is unverified. Same remedy: one live call.
- **Truncation unit.** Whether `truncated` cuts the state at a prefix (so that `state_text` is a prefix of S) is unverified.
- **KDL precedence.** The selector precedence between `models "*" { kind "judge" }` and a per-model `kind "extract"` was not read.
- **Missing-export import.** Whether a dynamic `import()` of a subpath missing from an older compiled host rejects cleanly, rather than failing at plugin link time, was not tested.
- **Unread code.** `roleDefaultModels()` and the telemetry span schema were not read; the role-default and telemetry proposals are [INFERENCE].
- **Unsearched branches.** Upstream `main` past `v18.17.0`, and open upstream PRs, were not searched for an extraction proposal.

## Addendum: OpenRouter route (2026-11-06)

Eric will reach Clairic through OpenRouter, so the role's first runner targets OpenRouter's Extractions API, and Workers AI becomes optional (`plans/evidence-layer.md`, Decision Log).

- **Route.** `POST https://openrouter.ai/api/alpha/extractions` with `model: "cloudflare/clairic"`, `state`, and a `fields` map. It does not accept OpenAI-compatible chat requests. The route is alpha, and its shape can change. **source-read** https://openrouter.ai/docs/guides/community/extractions.
- **Offset unit.** OpenRouter documents `span`/`spans` as half-open `[start, end)` Unicode code-point offsets into the state text. `provider.options.cloudflare.return_state_text` returns that text as `state_text`. This answers the offset-unit gap above for this route; one live astral-character call should still confirm it. **source-read**, same page.
- **Other answer fields.** `value` (null when `p_null` crosses the field's `null_threshold`, default 0.5), `guess`, `p_null`, `confidence`, `truncated` (only a prefix was read), and `usage.cost`/`usage.passes`. A reported `usage.cost` lets cost be recorded as reported, not catalog. **source-read**, same page.
- **Availability.** The model page showed 96.09% availability over 3 days and 50.56% over the last 24 hours on 2026-11-06. **source-read** https://openrouter.ai/cloudflare/clairic. Extraction failures must therefore fall back to deterministic retrieval, never block a turn.
