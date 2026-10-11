import { describe, expect, test } from "bun:test";
import { admitCompressorCall, initialAdmission, parseAdmissionState, parseUsdDecimal } from "../scripts/evidence/admission.ts";
import { dollarAdmission, initialSpend, recordSpend, worstCaseCallUsd, type ModelRates } from "../scripts/evidence/cost.ts";
import { parseOptions } from "../scripts/evidence/options.ts";
import { factRecordCount, questionCount } from "../scripts/evidence/corpus.ts";

const BASE = ["--main", "openrouter/a", "--compressor", "openrouter/b"];
const FIXTURE = ["--main", "optchat-smoke/main", "--compressor", "optchat-smoke/compressor", "--fixture-provider"];
const RATES: ModelRates = { inputRate: 1, outputRate: 4, cacheReadRate: 0.1, cacheWriteRate: 1.25, contextWindow: 200_000, maxOutput: 8_192 };

describe("benchmark option defaults", () => {
	test("a bare run keeps every benchmark option at its prior default", () => {
		const options = parseOptions(BASE);
		expect(options.arms).toEqual(["on"]);
		expect(options.compressors).toEqual(["openrouter/b"]);
		expect(options.turnMode).toBe("batch");
		expect(options.viewBytes).toBe(4_096);
		expect(options.experiments).toEqual([]);
		expect(options.questionEmphasis).toBe("balanced");
		expect(options.maxCostUsd).toBeNull();
		expect(options.fixtureProvider).toBe(false);
		expect(options.projects).toBe(3);
		expect(options.sourceCount).toBe(24);
		expect(options.minSourceBytes).toBe(512);
		expect(options.questionLimit).toBe(8);
		expect(options.limits.maxCalls).toBe(80);
	});
});

describe("arms, compressors, and turn mode", () => {
	test("arms accept on, off, or both, and reject duplicates and unknown names", () => {
		expect(parseOptions([...BASE, "--arms", "on,off"]).arms).toEqual(["on", "off"]);
		expect(parseOptions([...BASE, "--arms", "off"]).arms).toEqual(["off"]);
		expect(() => parseOptions([...BASE, "--arms", "on,on"])).toThrow("repeats an entry");
		expect(() => parseOptions([...BASE, "--arms", "on,maybe"])).toThrow("--arms must name on and/or off");
	});

	test("compressors default to the single compressor and must begin with it", () => {
		const options = parseOptions([...BASE, "--compressors", "openrouter/b,openrouter/c", "--arms", "on,off"]);
		expect(options.compressors).toEqual(["openrouter/b", "openrouter/c"]);
		expect(() => parseOptions([...BASE, "--compressors", "openrouter/c,openrouter/b"])).toThrow("must begin with the --compressor");
		expect(() => parseOptions([...BASE, "--compressors", "@bad,openrouter/b"])).toThrow("provider/model");
		expect(() => parseOptions([...BASE, "--compressors", "openrouter/b,openrouter/b"])).toThrow("repeats an entry");
		expect(() => parseOptions([...BASE, "--compressors", "openrouter/b,"])).toThrow("empty entry");
	});

	test("several compressors need the on arm, since each compressor has one on arm", () => {
		expect(() => parseOptions([...BASE, "--compressors", "openrouter/b,openrouter/c", "--arms", "off"])).toThrow("requires the on arm");
	});

	test("turn mode is batch or per-question", () => {
		expect(parseOptions([...BASE, "--turn-mode", "per-question"]).turnMode).toBe("per-question");
		expect(() => parseOptions([...BASE, "--turn-mode", "stream"])).toThrow("--turn-mode must be one of batch, per-question");
	});
});

describe("view bytes, experiments, and emphasis", () => {
	test("view bytes span 4096 to 128000 inclusive", () => {
		expect(parseOptions([...BASE, "--view-bytes", "4096"]).viewBytes).toBe(4_096);
		expect(parseOptions([...BASE, "--view-bytes", "128000"]).viewBytes).toBe(128_000);
		expect(() => parseOptions([...BASE, "--view-bytes", "4095"])).toThrow("from 4096 to 128000");
		expect(() => parseOptions([...BASE, "--view-bytes", "128001"])).toThrow("from 4096 to 128000");
		expect(() => parseOptions([...BASE, "--view-bytes", "lots"])).toThrow("non-negative integer");
	});

	test("experiments accept only child and reject duplicates", () => {
		expect(parseOptions([...BASE, "--experiments", "child"]).experiments).toEqual(["child"]);
		expect(() => parseOptions([...BASE, "--experiments", "other"])).toThrow("accepts only child");
		expect(() => parseOptions([...BASE, "--experiments", "child,child"])).toThrow("repeats an entry");
	});

	test("question emphasis is balanced or adversarial", () => {
		expect(parseOptions([...BASE, "--question-emphasis", "adversarial"]).questionEmphasis).toBe("adversarial");
		expect(() => parseOptions([...BASE, "--question-emphasis", "loud"])).toThrow("--question-emphasis must be one of");
	});
});

describe("cost cap flag", () => {
	const LIVE = [...BASE, "--confirm-live-provider-calls"];

	test("max-cost-usd is required with confirm and must be above 0 and at most 30", () => {
		expect(() => parseOptions(LIVE)).toThrow("--max-cost-usd is required");
		expect(parseOptions([...LIVE, "--max-cost-usd", "2.5"]).maxCostUsd).toBe(2.5);
		expect(parseOptions([...LIVE, "--max-cost-usd", "30"]).maxCostUsd).toBe(30);
		expect(() => parseOptions([...LIVE, "--max-cost-usd", "30.01"])).toThrow("at most 30");
		expect(() => parseOptions([...LIVE, "--max-cost-usd", "0"])).toThrow("above 0");
		expect(() => parseOptions([...LIVE, "--max-cost-usd", "-1"])).toThrow("decimal number");
		expect(() => parseOptions([...LIVE, "--max-cost-usd", "1e1"])).toThrow("decimal number");
	});

	test("without confirm, max-cost-usd is absent by default", () => {
		expect(parseOptions(BASE).maxCostUsd).toBeNull();
	});
});

describe("fixture provider", () => {
	test("fixture mode parses with optchat-smoke selectors and no confirm", () => {
		expect(parseOptions(FIXTURE).fixtureProvider).toBe(true);
	});

	test("fixture mode is mutually exclusive with confirm", () => {
		expect(() => parseOptions([...FIXTURE, "--confirm-live-provider-calls", "--max-cost-usd", "1"])).toThrow("mutually exclusive");
	});

	test("fixture selectors must be optchat-smoke models, including every compressor and the model change", () => {
		expect(() => parseOptions(["--main", "openrouter/a", "--compressor", "optchat-smoke/c", "--fixture-provider"])).toThrow("requires optchat-smoke/");
		expect(() => parseOptions(["--main", "optchat-smoke/m", "--compressor", "optchat-smoke/c", "--compressors", "optchat-smoke/c,openrouter/x", "--arms", "on,off", "--fixture-provider"])).toThrow("requires optchat-smoke/");
		expect(() => parseOptions([...FIXTURE, "--scenarios", "model-change", "--model-change", "openrouter/other"])).toThrow("requires optchat-smoke/");
	});
});

describe("corpus bounds", () => {
	test("projects span 2 to 40 and questions are bounded by the project count", () => {
		expect(() => parseOptions([...BASE, "--projects", "1"])).toThrow("from 2 to 40");
		expect(() => parseOptions([...BASE, "--projects", "41"])).toThrow("from 2 to 40");
		expect(parseOptions([...BASE, "--projects", "40", "--sources", String(factRecordCount(40)), "--questions", String(questionCount(40))]).questionLimit).toBe(244);
		expect(() => parseOptions([...BASE, "--projects", "40", "--sources", String(factRecordCount(40)), "--questions", "245"])).toThrow("from 1 to 244");
		expect(() => parseOptions([...BASE, "--questions", "23"])).toThrow("from 1 to 22");
	});

	test("sources span 16 to 512 and must cover the fact records of the project count", () => {
		expect(parseOptions([...BASE, "--sources", "512"]).sourceCount).toBe(512);
		expect(() => parseOptions([...BASE, "--sources", "513"])).toThrow("from 16 to 512");
		expect(() => parseOptions([...BASE, "--projects", "40", "--sources", "292"])).toThrow(`needs ${factRecordCount(40)} fact records`);
		expect(parseOptions([...BASE, "--projects", "40", "--sources", String(factRecordCount(40))]).sourceCount).toBe(factRecordCount(40));
	});

	test("min source bytes span 512 to 32768", () => {
		expect(parseOptions([...BASE, "--min-source-bytes", "32768"]).minSourceBytes).toBe(32_768);
		expect(() => parseOptions([...BASE, "--min-source-bytes", "32769"])).toThrow("from 512 to 32768");
	});
});

describe("unknown and duplicate flags stay rejected", () => {
	test("new flags are value flags and cannot be duplicated", () => {
		expect(() => parseOptions([...BASE, "--arms", "on", "--arms", "off"])).toThrow("duplicate flag");
		expect(() => parseOptions([...BASE, "--fixture-provider", "--fixture-provider"])).toThrow("duplicate flag");
		expect(() => parseOptions([...BASE, "--view-bytes"])).toThrow("requires a value");
	});
});

describe("exact worst-case cost arithmetic", () => {
	test("prompt at the dearest input rate plus output at the output rate, per million tokens", () => {
		// 1000 * max(1, 1.25, 0.1) + 512 * 4 = 1250 + 2048 = 3298 micro-units per million
		expect(worstCaseCallUsd(RATES, 1_000, 512)).toBeCloseTo(0.003298, 12);
	});

	test("output is clamped to the catalog ceiling when one is stated", () => {
		// 1000 * 1.25 + 100 * 4 = 1650
		expect(worstCaseCallUsd({ ...RATES, maxOutput: 100 }, 1_000, 512)).toBeCloseTo(0.00165, 12);
	});

	test("the prompt bound may equal the context window but not exceed it", () => {
		expect(worstCaseCallUsd(RATES, 200_000, 1)).toBeCloseTo((200_000 * 1.25 + 4) / 1e6, 12);
		expect(() => worstCaseCallUsd(RATES, 200_001, 1)).toThrow("exceed the context window");
	});

	test("unknown rates, unknown context window, or a missing model refuse with null", () => {
		expect(worstCaseCallUsd(null, 1_000, 512)).toBeNull();
		expect(worstCaseCallUsd({ ...RATES, inputRate: null }, 1_000, 512)).toBeNull();
		expect(worstCaseCallUsd({ ...RATES, cacheWriteRate: null }, 1_000, 512)).toBeNull();
		expect(worstCaseCallUsd({ ...RATES, outputRate: Number.NaN }, 1_000, 512)).toBeNull();
		expect(worstCaseCallUsd({ ...RATES, contextWindow: null }, 1_000, 512)).toBeNull();
	});
});

describe("dollar admission and spend ledger", () => {
	test("a call within the cap is admitted; a call over it is refused as cost-cap", () => {
		expect(dollarAdmission(0, 0.003298, 0.01)).toEqual({ admitted: true });
		expect(dollarAdmission(0.0099, 0.003298, 0.01)).toEqual({ admitted: false, reason: "cost-cap" });
	});

	test("unknown spend or unknown bound refuses as unknown-cost", () => {
		expect(dollarAdmission(null, 0.001, 1)).toEqual({ admitted: false, reason: "unknown-cost" });
		expect(dollarAdmission(0, null, 1)).toEqual({ admitted: false, reason: "unknown-cost" });
	});

	test("a spend ledger sums observed costs and stays unobservable once it is null", () => {
		const summed = recordSpend(recordSpend(initialSpend(), 0.5), 0.25);
		expect(summed.observedUsd).toBe(0.75);
		expect(recordSpend(recordSpend(initialSpend(), null), 0.25).observedUsd).toBeNull();
	});
});

describe("admission ledger", () => {
	test("a fresh ledger reserves nothing", () => {
		expect(initialAdmission()).toEqual({ dispatched: 0, reservedUsd: 0 });
	});

	test("admission counts the call and reserves its worst case, returning the next state", () => {
		const decision = admitCompressorCall({ dispatched: 0, reservedUsd: 0 }, 2, 0.25, 1);
		expect(decision).toEqual({ admitted: true, state: { dispatched: 1, reservedUsd: 0.25 } });
	});

	test("the call allowance refuses before any dollar check", () => {
		const decision = admitCompressorCall({ dispatched: 2, reservedUsd: 0.5 }, 2, 0.25, 10);
		expect(decision).toEqual({ admitted: false, reason: "call-cap", state: { dispatched: 2, reservedUsd: 0.5 } });
	});

	test("dollar overflow refuses as cost-cap, and a reservation landing exactly on the allowance is admitted", () => {
		expect(admitCompressorCall({ dispatched: 1, reservedUsd: 0.5 }, 5, 0.5, 1).admitted).toBe(true);
		const refused = admitCompressorCall({ dispatched: 1, reservedUsd: 0.75 }, 5, 0.5, 1);
		expect(refused).toEqual({ admitted: false, reason: "cost-cap", state: { dispatched: 1, reservedUsd: 0.75 } });
	});

	test("a zero per-call worst case admits until the call allowance", () => {
		expect(admitCompressorCall({ dispatched: 0, reservedUsd: 0 }, 1, 0, 0).admitted).toBe(true);
	});

	test("the state parse is strict: missing, extra, and negative fields throw", () => {
		expect(() => parseAdmissionState({ dispatched: 0 })).toThrow("unexpected or missing fields");
		expect(() => parseAdmissionState({ dispatched: 0, reservedUsd: 0, extra: 1 })).toThrow("unexpected or missing fields");
		expect(() => parseAdmissionState({ dispatched: -1, reservedUsd: 0 })).toThrow("dispatched");
		expect(() => parseAdmissionState({ dispatched: 0, reservedUsd: -0.1 })).toThrow("reservedUsd");
		expect(() => parseAdmissionState([])).toThrow("malformed");
		expect(() => parseAdmissionState(null)).toThrow("malformed");
	});

	test("admission arguments are validated, not trusted", () => {
		expect(() => admitCompressorCall({ dispatched: 0, reservedUsd: 0 }, -1, 0.1, 1)).toThrow("call allowance");
		expect(() => admitCompressorCall({ dispatched: 0, reservedUsd: 0 }, 1, Number.NaN, 1)).toThrow("per-call USD");
		expect(() => admitCompressorCall({ dispatched: 0, reservedUsd: 0 }, 1, 0.1, Number.POSITIVE_INFINITY)).toThrow("USD allowance");
	});

	test("the environment decimal parser accepts plain decimals and rejects signs, exponents, and overflow", () => {
		expect(parseUsdDecimal("0.25", "X")).toBe(0.25);
		expect(parseUsdDecimal(".5", "X")).toBe(0.5);
		expect(parseUsdDecimal("3", "X")).toBe(3);
		expect(() => parseUsdDecimal("1e3", "X")).toThrow("non-negative decimal");
		expect(() => parseUsdDecimal("-1", "X")).toThrow("non-negative decimal");
		expect(() => parseUsdDecimal("", "X")).toThrow("non-negative decimal");
		expect(() => parseUsdDecimal("9".repeat(400), "X")).toThrow("finite decimal");
	});
});
