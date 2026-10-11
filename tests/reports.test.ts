import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { type ArtifactPathSource, captureWorkReports } from "../src/reports.ts";

const TIMESTAMP = 1_767_225_600_000;

/** Records every artifact lookup; resolves only the ids present in `files`. */
function artifactReader(files: Record<string, string>): ArtifactPathSource & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getArtifactPath(id: string): Promise<string | null> {
      calls.push(id);
      return files[id] ?? null;
    },
  };
}

/** Adds an undeclared directory accessor: any `<agentId>.md` lookup would read the stale file and count as an access. */
function hostileArtifactReader(files: Record<string, string>, directory: string) {
  const base = artifactReader(files);
  let accesses = 0;
  const reader = {
    ...base,
    getArtifactsDir: (): string => {
      accesses += 1;
      return directory;
    },
    directoryAccesses: (): number => accesses,
  };
  return reader;
}

async function withArtifactDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "optchat-reports-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("captureWorkReports artifact hydration", () => {
  test("a truncated async report hydrates the full output from a real temp file longer than the preview cap", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "7.txt");
      const full = `${"line of output\n".repeat(30_000)}END-MARKER`;
      expect(full.length).toBeGreaterThan(12_000);
      await writeFile(path, full);
      const reader = artifactReader({ "7": path });
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { jobs: [{ jobId: "bg_1", type: "bash", status: "completed", label: "build", meta: { truncation: { artifactId: "7" } } }] },
        text: "preview of the build output",
        sessionManager: reader,
      });
      expect(capture.completeness).toBe("full");
      expect(capture.reason).toBeUndefined();
      expect(capture.reports).toHaveLength(1);
      const [report] = capture.reports;
      expect(report!.work.completeness).toBe("full");
      expect(report!.work.id).toBe("bg_1");
      expect(report!.work.name).toBe("build");
      expect(report!.body).toContain(full);
      expect(report!.body.startsWith("preview of the build output")).toBe(true);
      expect(report!.envelope).toBe("preview of the build output");
      expect(report!.timestamp).toBe(TIMESTAMP);
      expect(reader.calls).toEqual(["7"]);
    });
  });

  test("an aggregate artifact reference applies only to a single delivered job", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "3.txt");
      await writeFile(path, "complete aggregate output");
      const reader = artifactReader({ "3": path });
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { jobs: [{ jobId: "bg_2" }], meta: { truncation: { artifactId: "3" } } },
        text: "preview",
        sessionManager: reader,
      });
      expect(capture.completeness).toBe("full");
      expect(capture.reports[0]!.body).toContain("complete aggregate output");
    });
  });

  test("an async-result with no job details but an aggregate artifact hydrates through the admitted lookup", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "4.txt");
      await writeFile(path, "aggregate without jobs");
      const reader = artifactReader({ "4": path });
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { meta: { truncation: { artifactId: "4" } } },
        text: "preview",
        sessionManager: reader,
      });
      expect(capture.completeness).toBe("full");
      expect(capture.reports[0]!.body).toContain("aggregate without jobs");
      expect(reader.calls).toEqual(["4"]);
    });
  });
});

/** Longer than the 5,000-character nested preview the host renders for an unstructured task report. */
const PREVIEW_BODY = "first part of the review; ".repeat(250);

function nestedPreview(agentId: string): string {
  return `<preview full-output="agent://${agentId}">\n${PREVIEW_BODY}\n</preview>`;
}

describe("captureWorkReports nested task previews", () => {
  const taskJob = (agentId: string) => ({ jobId: "bg_task", agentId, label: "review", type: "task", status: "completed" });

  for (const form of ["outer", "nested"] as const) {
    test(`a ${form} wake preview cannot hydrate stale output from a reused typed task agent ID`, async () => {
      await withArtifactDirectory(async (directory) => {
        const agentId = "0-Reviewer";
        const bodyAgentId = "1-BodyOnly";
        const stale = "RUN-A-STALE-FINDING";
        const path = join(directory, `${agentId}.md`);
        const bodyPath = join(directory, `${bodyAgentId}.md`);
        await writeFile(path, stale);
        await writeFile(bodyPath, "BODY-ID-MUST-NOT-BE-READ");
        const text = form === "outer"
          ? `RUN-B-CURRENT-PREVIEW\n${PREVIEW_BODY.repeat(3)}\n[Output truncated. Showing first 12,000 characters.]\nFull output: agent://${bodyAgentId}`
          : `RUN-B-CURRENT-PREVIEW\n${nestedPreview(bodyAgentId)}`;
        if (form === "outer") expect(text.length).toBeGreaterThan(12_000);
        else expect(text.length).toBeLessThan(12_000);
        const reader = hostileArtifactReader({ [agentId]: path, [bodyAgentId]: bodyPath }, directory);
        const capture = await captureWorkReports({
          source: "async-result",
          timestamp: TIMESTAMP,
          details: { jobs: [taskJob(agentId)] },
          text,
          sessionManager: reader,
        });
        expect(capture.completeness).toBe("pointer-only");
        expect(capture.reports).toHaveLength(1);
        const [report] = capture.reports;
        expect(report!.work.agentId).toBe(agentId);
        expect(report!.work.completeness).toBe("pointer-only");
        expect(report!.reason).toBe("the host delivered a preview; the full output is referenced only in text");
        expect(capture.reason).toBe(report!.reason);
        expect(report!.envelope).toBe(text);
        expect(report!.body).toBe(text);
        expect(report!.body).not.toContain(stale);
        expect(report!.body).not.toContain("BODY-ID-MUST-NOT-BE-READ");
        expect(reader.calls).toEqual([]);
        expect(reader.directoryAccesses()).toBe(0);
      });
    });
  }

  test("a multi-job wake preview conservatively downgrades every unstructured member despite stale agent files", async () => {
    await withArtifactDirectory(async (directory) => {
      const firstId = "0-Reviewer";
      const secondId = "1-Reviewer";
      const bodyAgentId = "2-BodyOnly";
      const firstPath = join(directory, `${firstId}.md`);
      const secondPath = join(directory, `${secondId}.md`);
      const bodyPath = join(directory, `${bodyAgentId}.md`);
      await writeFile(firstPath, "RUN-A-FIRST-STALE");
      await writeFile(secondPath, "RUN-A-SECOND-STALE");
      await writeFile(bodyPath, "BODY-ID-MUST-NOT-BE-READ");
      const reader = hostileArtifactReader({ [firstId]: firstPath, [secondId]: secondPath, [bodyAgentId]: bodyPath }, directory);
      const text = `RUN-B-CURRENT-PREVIEW\n${nestedPreview(bodyAgentId)}\nOther job: short inline output`;
      expect(text.length).toBeLessThan(12_000);
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { jobs: [taskJob(firstId), { ...taskJob(secondId), jobId: "bg_other" }] },
        text,
        sessionManager: reader,
      });
      expect(capture.completeness).toBe("pointer-only");
      expect(capture.reports.map((report) => report.work.id)).toEqual(["bg_task", "bg_other"]);
      expect(capture.reports.map((report) => report.work.agentId)).toEqual([firstId, secondId]);
      for (const report of capture.reports) {
        expect(report.work.completeness).toBe("pointer-only");
        expect(report.reason).toBe("the host delivered a preview; the full output is referenced only in text");
        expect(capture.reason).toBe(report.reason);
        expect(report.envelope).toBe(text);
        expect(report.body).toBe(text);
        expect(report.body).not.toContain("RUN-A-");
        expect(report.body).not.toContain("BODY-ID-MUST-NOT-BE-READ");
      }
      expect(reader.calls).toEqual([]);
      expect(reader.directoryAccesses()).toBe(0);
    });
  });

  test("typed numeric metadata hydrates genuinely full output for a task with a reused agent ID", async () => {
    await withArtifactDirectory(async (directory) => {
      const agentId = "0-Reviewer";
      const stalePath = join(directory, `${agentId}.md`);
      const path = join(directory, "12.txt");
      const full = `RUN-B-FULL\n${"current finding\n".repeat(1_000)}RUN-B-LAST-FINDING`;
      await writeFile(stalePath, "RUN-A-STALE-FINDING");
      await writeFile(path, full);
      const reader = artifactReader({ "12": path, [agentId]: stalePath });
      const text = nestedPreview("1-BodyOnly");
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { jobs: [{ ...taskJob(agentId), meta: { truncation: { artifactId: "12" } } }] },
        text,
        sessionManager: reader,
      });
      expect(full.length).toBeGreaterThan(12_000);
      expect(capture.completeness).toBe("full");
      expect(capture.reason).toBeUndefined();
      expect(capture.reports).toHaveLength(1);
      const [report] = capture.reports;
      expect(report!.work.completeness).toBe("full");
      expect(report!.work.agentId).toBe(agentId);
      expect(report!.reason).toBeUndefined();
      expect(report!.envelope).toBe(text);
      expect(report!.body.startsWith(text)).toBe(true);
      expect(report!.body).toContain(full);
      expect(report!.body).not.toContain("RUN-A-STALE-FINDING");
      expect(reader.calls).toEqual(["12"]);
    });
  });

  test("a numeric artifact containing a nested preview remains incomplete without recursive lookup", async () => {
    await withArtifactDirectory(async (directory) => {
      const agentId = "0-Reviewer";
      const bodyAgentId = "1-BodyOnly";
      const stalePath = join(directory, `${agentId}.md`);
      const bodyPath = join(directory, `${bodyAgentId}.md`);
      const path = join(directory, "13.txt");
      const recursivePath = join(directory, "14.txt");
      await writeFile(stalePath, "RUN-A-STALE-FINDING");
      await writeFile(bodyPath, "BODY-ID-MUST-NOT-BE-READ");
      await writeFile(recursivePath, "RECURSIVE-ARTIFACT-MUST-NOT-BE-READ");
      const preview = `RUN-B-NESTED-PREVIEW\n${nestedPreview(bodyAgentId)}\nFull output: artifact://14`;
      expect(preview.length).toBeLessThan(12_000);
      await writeFile(path, preview);
      const reader = artifactReader({ "13": path, "14": recursivePath, [agentId]: stalePath, [bodyAgentId]: bodyPath });
      const text = "RUN-B-WAKE-PREVIEW\n[Output truncated. Showing first 12,000 characters.]";
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { jobs: [{ ...taskJob(agentId), meta: { truncation: { artifactId: "13" } } }] },
        text,
        sessionManager: reader,
      });
      expect(capture.completeness).toBe("pointer-only");
      expect(capture.reports).toHaveLength(1);
      const [report] = capture.reports;
      expect(report!.work.completeness).toBe("pointer-only");
      expect(report!.reason).toContain("preview");
      expect(capture.reason).toBe(report!.reason);
      expect(report!.envelope).toBe(text);
      expect(report!.body).toContain(text);
      expect(report!.body).not.toContain("RUN-A-STALE-FINDING");
      expect(report!.body).not.toContain("BODY-ID-MUST-NOT-BE-READ");
      expect(report!.body).not.toContain("RECURSIVE-ARTIFACT-MUST-NOT-BE-READ");
      expect(reader.calls).toEqual(["13"]);
    });
  });
});

describe("captureWorkReports batch members", () => {
  test("every named task member is retained separately with its own public output", async () => {
    const capture = await captureWorkReports({
      source: "task",
      timestamp: TIMESTAMP,
      details: {
        results: [
          { id: "alpha", agent: "reviewer", output: "alpha finding", exitCode: 0, durationMs: 10, truncated: false },
          { id: "beta", agent: "explore", output: "beta finding", exitCode: 0, durationMs: 20, truncated: false },
          { id: "gamma", agent: "reviewer", output: "gamma finding", exitCode: 0, durationMs: 30, truncated: false },
        ],
      },
      text: "<task-result>three members</task-result>",
    });
    expect(capture.completeness).toBe("full");
    expect(capture.reports.map((report) => report.work.agentId)).toEqual(["alpha", "beta", "gamma"]);
    expect(capture.reports.map((report) => report.work.name)).toEqual(["reviewer", "explore", "reviewer"]);
    expect(capture.reports.map((report) => report.provenance.durationMs)).toEqual([10, 20, 30]);
    expect(capture.reports[0]!.body).toContain("alpha finding");
    expect(capture.reports[0]!.body).not.toContain("beta finding");
    expect(capture.reports[1]!.body).toContain("beta finding");
    expect(capture.reports[2]!.body).toContain("gamma finding");
    for (const report of capture.reports) {
      expect(report.envelope).toBe("<task-result>three members</task-result>");
    }
  });

  test("named async jobs keep their own structured data and provenance", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: {
        jobs: [
          {
            jobId: "bg_a", agentId: "agent-a", label: "first", type: "task", status: "completed", durationMs: 5,
            schema: { source: "task", mode: "strict", status: "valid", data: { rows: 1 } },
          },
          {
            jobId: "bg_b", agentId: "agent-b", label: "second", type: "task", status: "completed", durationMs: 6,
            schema: { source: "task", mode: "strict", status: "valid", data: { rows: 2 } },
          },
        ],
      },
      text: "two jobs",
    });
    expect(capture.completeness).toBe("full");
    expect(capture.reports.map((report) => report.work.id)).toEqual(["bg_a", "bg_b"]);
    expect(capture.reports.map((report) => report.work.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(capture.reports[0]!.body).toContain('"rows":1');
    expect(capture.reports[1]!.body).toContain('"rows":2');
    expect(capture.reports[0]!.provenance).toEqual({ type: "task", status: "completed", durationMs: 5 });
  });
});

describe("captureWorkReports completeness", () => {
  test("a mixed batch of full and pointer-only members never claims the whole batch is full", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: {
        jobs: [
          {
            jobId: "bg_full",
            schema: { source: "task", mode: "permissive", status: "valid", data: { ok: true } },
          },
          { jobId: "bg_missing", label: "no structure, no reference" },
        ],
      },
      text: "mixed\n\n[Output truncated. Showing first 4,000 characters.]",
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.work.completeness).toBe("full");
    expect(capture.reports[1]!.work.completeness).toBe("pointer-only");
    expect(capture.reports[1]!.reason).toBeDefined();
    expect(capture.reason).toBe(capture.reports[1]!.reason);
    expect(capture.reports[1]!.body).toBe("mixed\n\n[Output truncated. Showing first 4,000 characters.]");
  });

  test("an inline report the host never elided is captured whole without structured data", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_inline", status: "completed" }] },
      text: "whole inline output",
    });
    expect(capture.completeness).toBe("full");
    expect(capture.reports[0]!.reason).toBeUndefined();
  });

  test("tool-level elision keeps an unmarked inline report incomplete", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_cut", meta: { truncation: { artifactId: "9", artifactElidedBytes: 10 } } }] },
      text: "head … tail",
    });
    expect(capture.completeness).toBe("pointer-only");
  });

  test("invalid structured output is retained as evidence but never claimed as full", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: {
        jobs: [{ jobId: "bg_bad", schema: { source: "task", mode: "strict", status: "invalid", error: "missing field", data: { partial: true } } }],
      },
      text: "invalid",
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("structured output failed validation");
    expect(capture.reports[0]!.body).toContain('"partial":true');
  });

  test("a task result truncated without an artifact reference stays pointer-only with its partial output", async () => {
    const capture = await captureWorkReports({
      source: "task",
      timestamp: TIMESTAMP,
      details: { results: [{ id: "cut", agent: "task", output: "partial text", exitCode: 0, truncated: true }] },
      text: "cut",
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("task output was truncated and no artifact reference was delivered");
    expect(capture.reports[0]!.body).toContain("partial text");
  });

  test("a running task is pointer-only even when its placeholder result looks complete", async () => {
    const capture = await captureWorkReports({
      source: "task",
      timestamp: TIMESTAMP,
      details: {
        async: { state: "running", jobId: "bg_t", type: "task" },
        results: [{ id: "later", agent: "task", output: "placeholder", exitCode: 0, truncated: false }],
      },
      text: "started",
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("task is still running");
  });
});

describe("captureWorkReports missing references", () => {
  test("a referenced artifact that the lookup cannot resolve stays pointer-only", async () => {
    const reader = artifactReader({});
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_m", meta: { truncation: { artifactId: "9" } } }] },
      text: "preview",
      sessionManager: reader,
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("artifact is unavailable");
    expect(capture.reports[0]!.body).toBe("preview");
    expect(reader.calls).toEqual(["9"]);
  });

  test("an unavailable artifact API is pointer-only and never read", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_n", meta: { truncation: { artifactId: "9" } } }] },
      text: "preview",
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("no artifact source is available");
  });

  test("a throwing lookup is pointer-only without leaking its error", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_x", meta: { truncation: { artifactId: "9" } } }] },
      text: "preview",
      sessionManager: {
        async getArtifactPath(): Promise<string | null> {
          throw new Error("/private/session/path leaked");
        },
      },
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("artifact lookup failed");
    expect(capture.reports[0]!.reason).not.toContain("/private");
  });

  test("a referenced artifact with a missing file on disk stays pointer-only", async () => {
    await withArtifactDirectory(async (directory) => {
      const reader = artifactReader({ "11": join(directory, "gone.txt") });
      const capture = await captureWorkReports({
        source: "async-result",
        timestamp: TIMESTAMP,
        details: { jobs: [{ jobId: "bg_gone", meta: { truncation: { artifactId: "11" } } }] },
        text: "preview",
        sessionManager: reader,
      });
      expect(capture.completeness).toBe("pointer-only");
      expect(capture.reports[0]!.reason).toBe("artifact is unreadable or not UTF-8");
    });
  });

  test("a sampled artifact is never read and stays pointer-only", async () => {
    const reader = artifactReader({ "5": "/unused" });
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_s", meta: { truncation: { artifactId: "5", artifactElidedBytes: 100 } } }] },
      text: "preview",
      sessionManager: reader,
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("artifact holds a head and tail sample, not the full output");
    expect(reader.calls).toEqual([]);
  });
});

describe("captureWorkReports privacy and arbitrary body references", () => {
  test("body URIs and paths in delivered text are never read", async () => {
    const reader = artifactReader({ "7": "/should/never/be/read" });
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_u" }] },
      text: "preview\nFull output: artifact://7 and agent://bg_u and /etc/passwd",
      sessionManager: reader,
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(reader.calls).toEqual([]);
    expect(capture.reports[0]!.body).toBe("preview\nFull output: artifact://7 and agent://bg_u and /etc/passwd");
  });

  test("a non-numeric artifact reference from typed metadata is rejected before any lookup", async () => {
    const reader = artifactReader({ "../secret": "/etc/passwd" });
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "bg_p", meta: { truncation: { artifactId: "../secret" } } }] },
      text: "preview",
      sessionManager: reader,
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("artifact reference is not admitted");
    expect(reader.calls).toEqual([]);
  });

  test("thinking and undeclared fields never enter a captured body", async () => {
    const capture = await captureWorkReports({
      source: "task",
      timestamp: TIMESTAMP,
      details: {
        results: [
          {
            id: "private",
            agent: "task",
            output: "public answer",
            exitCode: 0,
            truncated: false,
            thinking: "PRIVATE-THOUGHT",
            content: [{ type: "thinking", thinking: "PRIVATE-THOUGHT" }],
            structuredOutput: {
              source: "agent", mode: "strict", status: "valid", data: { answer: 1 }, reasoning: "PRIVATE-THOUGHT",
            },
          },
        ],
      },
      text: "public",
    });
    expect(capture.reports[0]!.body).toContain("public answer");
    expect(capture.reports[0]!.body).toContain('"answer":1');
    expect(capture.reports[0]!.body).not.toContain("PRIVATE-THOUGHT");
  });

  test("a launch-completion daemon snapshot keeps only its declared fields", async () => {
    const capture = await captureWorkReports({
      source: "launch-completion",
      timestamp: TIMESTAMP,
      details: {
        daemons: [
          { name: "api", id: "d1", state: "exited", exitCode: 1, outputBytes: 42, secretEnv: "TOKEN-VALUE" },
          { name: "worker", id: "d2", state: "failed", exitCode: 2, outputBytes: 0 },
        ],
      },
      text: "daemons exited",
    });
    expect(capture.completeness).toBe("full");
    expect(capture.reports).toHaveLength(2);
    expect(capture.reports[0]!.work.id).toBe("d1");
    expect(capture.reports[0]!.work.name).toBe("api");
    expect(capture.reports[0]!.provenance).toEqual({ status: "exited", exitCode: 1 });
    expect(capture.reports[0]!.body).toContain('"exitCode":1');
    expect(capture.reports[0]!.body).not.toContain("TOKEN-VALUE");
    expect(capture.reports[1]!.work.id).toBe("d2");
  });
});

describe("captureWorkReports identifiers and inputs", () => {
  test("an overlong identifier is omitted while its member is still retained", async () => {
    const capture = await captureWorkReports({
      source: "async-result",
      timestamp: TIMESTAMP,
      details: { jobs: [{ jobId: "x".repeat(257), schema: { source: "task", mode: "strict", status: "valid", data: 1 } }] },
      text: "long id",
    });
    expect(capture.reports).toHaveLength(1);
    expect(capture.reports[0]!.work.id).toBeUndefined();
    expect(capture.reports[0]!.work.completeness).toBe("full");
  });

  test("a non-finite source timestamp is rejected", async () => {
    await expect(captureWorkReports({
      source: "task",
      timestamp: Number.NaN,
      details: undefined,
      text: "",
    })).rejects.toThrow("Work timestamp must be finite milliseconds");
  });

  test("an unknown source is rejected", async () => {
    await expect(captureWorkReports({
      source: "shell" as never,
      timestamp: TIMESTAMP,
      details: undefined,
      text: "",
    })).rejects.toThrow("Unsupported work source");
  });

  test("a message without any details is one pointer-only report carrying its delivered text", async () => {
    const capture = await captureWorkReports({
      source: "task",
      timestamp: TIMESTAMP,
      details: undefined,
      text: "bare text",
    });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports).toHaveLength(1);
    expect(capture.reports[0]!.body).toBe("bare text");
  });
});
