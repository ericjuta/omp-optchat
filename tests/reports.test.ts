import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { type ArtifactPathSource, captureWaitReports, captureWorkReports } from "../src/reports.ts";
import type { FakeHost, HostMessage } from "./helpers/fake-host.ts";
import { ALL_GATES_OFF, Harness } from "./helpers/system1-chat.ts";

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

/** One job snapshot of a host `wait` result, as `details.jobs` holds it. */
interface WaitJob {
  id: string;
  type: "task" | "bash";
  status: "completed" | "failed" | "running";
  label: string;
  durationMs?: number;
  agentUrlId?: string;
  /** Absent once the host already delivered the job by itself. */
  resultText?: string;
  errorText?: string;
  report?: unknown;
  structured?: unknown;
}

/** A `wait` result as the host renders it: the text the model reads and the job snapshots in its details. */
function waitResult(jobs: readonly WaitJob[]): { text: string; details: Record<string, unknown> } {
  const finished = jobs.filter((job) => job.status !== "running");
  const running = jobs.filter((job) => job.status === "running");
  const lines: string[] = [];
  if (finished.length > 0) {
    lines.push(`## Completed (${finished.length})`, "");
    for (const job of finished) {
      lines.push(`### ${job.id} [${job.type}] — ${job.status}`, `Label: ${job.label}`);
      lines.push(job.resultText === undefined ? "Delivery: already delivered or recovered." : "Delivery: not auto-delivered; recovered by this snapshot.");
      if (job.resultText !== undefined) lines.push("```", job.resultText, "```");
      if (job.errorText !== undefined) lines.push(`Error: ${job.errorText}`);
      lines.push("");
    }
  }
  if (running.length > 0) {
    lines.push(`## Still Running (${running.length})`, "");
    for (const job of running) lines.push(`- \`${job.id}\` [${job.type}] — ${job.label}`);
  }
  return {
    text: lines.join("\n").trimEnd(),
    details: { op: "wait", meta: { source: { type: "report", value: "background jobs snapshot" } }, jobs },
  };
}

const REPORT_BYTE_LIMIT = 4 * 1024 * 1024;
const PREVIOUS_MESSAGE = "The full findings are in my previous message.";
const SUBSTANTIVE_TABLE = "| Finding | Evidence |\n| --- | --- |\n| EARLIER-TABLE | café: retained public evidence |";
const REPORT_RUN = "8e20bcd8-030d-4ba7-8410-932fd754207d";
const REPORT_AGENT = "0-TableReviewer";
const REPORT_PATHS = ["task", "wait", "async-result"] as const;
type ReportPath = typeof REPORT_PATHS[number];

interface TypedReportFixture {
  version: 1;
  runId: string;
  status: "complete";
  artifact: { id: string; uri: string; sha256: string; bytes: number };
}

/** Exact version-1 host reference; the digest and size bind the raw UTF-8 snapshot, not its preview. */
function typedReport(body: string | Uint8Array, id = "41", runId = REPORT_RUN): TypedReportFixture {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return {
    version: 1,
    runId,
    status: "complete",
    artifact: { id, uri: `artifact://${id}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength },
  };
}

/** Uses each host delivery's actual field names; own `report: undefined` is intentionally preserved. */
async function captureTypedReport(
  source: ReportPath,
  report: unknown,
  reader: ArtifactPathSource,
  { text = PREVIOUS_MESSAGE, structured }: { text?: string; structured?: unknown } = {},
) {
  if (source === "wait") {
    return captureWaitReports({
      ...waitResult([{ id: "bg_table", type: "task", status: "completed", label: "TableReviewer", agentUrlId: REPORT_AGENT,
        durationMs: 42, resultText: text, report, structured }]),
      timestamp: TIMESTAMP,
      sessionManager: reader,
    });
  }
  return captureWorkReports({
    source,
    timestamp: TIMESTAMP,
    text,
    sessionManager: reader,
    details: source === "task"
      ? { results: [{ id: REPORT_AGENT, agent: "TableReviewer", output: text, exitCode: 0, durationMs: 42, truncated: false,
        report, structuredOutput: structured }] }
      : { jobs: [{ jobId: "bg_table", type: "task", status: "completed", agentId: REPORT_AGENT, label: "TableReviewer", durationMs: 42,
        report, schema: structured }] },
  });
}

// References in these tests come from typed host metadata, never from model-controlled body text.
describe("typed task report snapshots", () => {
  for (const source of REPORT_PATHS) {
    test(`${source}: a short previous-message reply recovers its earlier substantive table`, async () => {
      await withArtifactDirectory(async (directory) => {
        const full = `${SUBSTANTIVE_TABLE}\n\n${PREVIOUS_MESSAGE}`;
        const path = join(directory, "41.txt");
        await writeFile(path, full);
        const reader = artifactReader({ "41": path });
        const capture = await captureTypedReport(source, typedReport(full), reader);
        expect(capture.completeness).toBe("full");
        expect(capture.reason).toBeUndefined();
        expect(capture.reports).toHaveLength(1);
        const report = capture.reports[0]!;
        expect(report.body).toContain(full);
        expect(report.envelope).toContain(source === "wait" ? "### bg_table [task] — completed" : PREVIOUS_MESSAGE);
        expect(report.work.source).toBe(source === "task" ? "task" : "async-result");
        expect(report.work.agentId).toBe(REPORT_AGENT);
        expect(report.work.name).toBe("TableReviewer");
        if (source !== "task") expect(report.work.id).toBe("bg_table");
        expect(report.work.completeness).toBe("full");
        expect(report.provenance.durationMs).toBe(42);
        expect(report.timestamp).toBe(TIMESTAMP);
        expect(report.reason).toBeUndefined();
        expect(reader.calls).toEqual(["41"]);
      });
    });

    test(`${source}: valid structured data still reads the authoritative public report`, async () => {
      await withArtifactDirectory(async (directory) => {
        const path = join(directory, "41.txt");
        await writeFile(path, SUBSTANTIVE_TABLE);
        const reader = artifactReader({ "41": path });
        const capture = await captureTypedReport(source, typedReport(SUBSTANTIVE_TABLE), reader, {
          text: '{"summary":"STRUCTURED-ONLY"}',
          structured: { source: "task", mode: "strict", status: "valid", data: { summary: "STRUCTURED-ONLY" } },
        });
        expect(capture.completeness).toBe("full");
        expect(capture.reports[0]!.body).toContain(SUBSTANTIVE_TABLE);
        expect(capture.reports[0]!.body).toContain("STRUCTURED-ONLY");
        expect(reader.calls).toEqual(["41"]);
      });
    });

    test(`${source}: unavailable typed artifact cannot fall back to valid structure or full-looking inline text`, async () => {
      const reader = artifactReader({});
      const capture = await captureTypedReport(source, typedReport(SUBSTANTIVE_TABLE), reader, {
        text: "This looks like a complete final answer.",
        structured: { source: "task", mode: "strict", status: "valid", data: { answer: "VALID-INLINE" } },
      });
      expect(capture.completeness).toBe("pointer-only");
      expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
      expect(capture.reports[0]!.reason).toContain("unavailable");
      expect(capture.reason).toBe(capture.reports[0]!.reason);
      expect(capture.reports[0]!.body).toContain("This looks like a complete final answer.");
      expect(capture.reports[0]!.body).not.toContain(SUBSTANTIVE_TABLE);
      expect(reader.calls).toEqual(["41"]);
    });
  }

  const malformed: readonly { name: string; reason?: RegExp; reference: (valid: TypedReportFixture) => unknown }[] = [
    { name: "null", reference: () => null },
    { name: "own undefined", reference: () => undefined },
    { name: "string", reference: () => "artifact://41" },
    { name: "array", reference: (valid) => [valid] },
    { name: "unknown report field", reference: (valid) => ({ ...valid, output: "UNADMITTED" }) },
    { name: "unknown artifact field", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, path: "/etc/passwd" } }) },
    { name: "partial missing reason", reason: /partial report reason/, reference: (valid) => ({ ...valid, status: "partial" }) },
    { name: "partial unknown reason", reason: /partial report reason/, reference: (valid) => ({ ...valid, status: "partial", reason: "finished" }) },
    { name: "unsupported version", reason: /version/, reference: (valid) => ({ ...valid, version: 2 }) },
    { name: "string version", reason: /version/, reference: (valid) => ({ ...valid, version: "1" }) },
    { name: "missing run", reason: /run identifier/, reference: (valid) => ({ ...valid, runId: undefined }) },
    { name: "empty run", reason: /run identifier/, reference: (valid) => ({ ...valid, runId: "" }) },
    { name: "nonstring run", reason: /run identifier/, reference: (valid) => ({ ...valid, runId: 42 }) },
    { name: "unknown status", reason: /status/, reference: (valid) => ({ ...valid, status: "completed" }) },
    { name: "complete with partial reason", reason: /partial reason/, reference: (valid) => ({ ...valid, reason: "failed" }) },
    { name: "missing artifact", reason: /no artifact/, reference: (valid) => ({ ...valid, artifact: undefined }) },
    { name: "artifact array", reference: (valid) => ({ ...valid, artifact: [valid.artifact] }) },
    { name: "numeric id value", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, id: 41 } }) },
    { name: "path id", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, id: "../secret", uri: "artifact://../secret" } }) },
    { name: "agent id", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, id: REPORT_AGENT, uri: `agent://${REPORT_AGENT}` } }) },
    { name: "noncanonical id", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, id: "041", uri: "artifact://041" } }) },
    { name: "unsafe integer id", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, id: "9007199254740992", uri: "artifact://9007199254740992" } }) },
    { name: "mismatched URI", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, uri: "artifact://42" } }) },
    { name: "body selector URI", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, uri: "artifact://41:raw" } }) },
    { name: "file URI", reason: /id and URI/, reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, uri: "file:///etc/passwd" } }) },
    { name: "uppercase digest", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, sha256: "A".repeat(64) } }) },
    { name: "short digest", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, sha256: "a".repeat(63) } }) },
    { name: "nonhex digest", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, sha256: "g".repeat(64) } }) },
    { name: "zero bytes", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, bytes: 0 } }) },
    { name: "negative bytes", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, bytes: -1 } }) },
    { name: "fractional bytes", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, bytes: 1.5 } }) },
    { name: "string bytes", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, bytes: String(valid.artifact.bytes) } }) },
    { name: "nonfinite bytes", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, bytes: Number.POSITIVE_INFINITY } }) },
    { name: "oversized declared bytes", reference: (valid) => ({ ...valid, artifact: { ...valid.artifact, bytes: REPORT_BYTE_LIMIT + 1 } }) },
  ];

  for (const source of REPORT_PATHS) {
    for (const { name, reason = /malformed/, reference } of malformed) {
      test(`${source}: ${name} report metadata fails closed before artifact lookup`, async () => {
        await withArtifactDirectory(async (directory) => {
          const path = join(directory, "41.txt");
          await writeFile(path, SUBSTANTIVE_TABLE);
          const reader = artifactReader({ "41": path });
          const capture = await captureTypedReport(source, reference(typedReport(SUBSTANTIVE_TABLE)), reader, {
            text: "UNTRUNCATED-INLINE-ANSWER",
            structured: { source: "task", mode: "strict", status: "valid", data: { answer: "STRUCTURED-FALLBACK" } },
          });
          expect(capture.completeness).toBe("pointer-only");
          expect(capture.reports).toHaveLength(1);
          expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
          expect(capture.reports[0]!.reason).toMatch(reason);
          expect(capture.reason).toBe(capture.reports[0]!.reason);
          expect(capture.reports[0]!.body).toContain("UNTRUNCATED-INLINE-ANSWER");
          expect(capture.reports[0]!.body).not.toContain(SUBSTANTIVE_TABLE);
          expect(reader.calls).toEqual([]);
        });
      });
    }
  }

  for (const [name, change, reason] of [
    ["wrong digest", (valid: TypedReportFixture) => ({ ...valid.artifact, sha256: "0".repeat(64) }), /hash|digest|sha256/i],
    ["understated bytes", (valid: TypedReportFixture) => ({ ...valid.artifact, bytes: valid.artifact.bytes - 1 }), /byte|size/],
    ["overstated bytes", (valid: TypedReportFixture) => ({ ...valid.artifact, bytes: valid.artifact.bytes + 1 }), /byte|size/],
    ["character count instead of UTF-8 bytes", (valid: TypedReportFixture) => ({ ...valid.artifact, bytes: SUBSTANTIVE_TABLE.length }), /byte|size/],
  ] as const) {
    test(`${name} rejects a real artifact instead of accepting full-looking inline output`, async () => {
      await withArtifactDirectory(async (directory) => {
        const path = join(directory, "41.txt");
        await writeFile(path, SUBSTANTIVE_TABLE);
        const reader = artifactReader({ "41": path });
        const valid = typedReport(SUBSTANTIVE_TABLE);
        const capture = await captureTypedReport("async-result", { ...valid, artifact: change(valid) }, reader);
        expect(capture.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.reason).toMatch(reason);
        expect(capture.reason).toBe(capture.reports[0]!.reason);
        expect(capture.reports[0]!.body).toBe(PREVIOUS_MESSAGE);
        expect(reader.calls).toEqual(["41"]);
      });
    });
  }

  test("replacement at the same numeric artifact path cannot swap a previously bound report", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "41.txt");
      const original = "RUN-A-TABLE";
      const replacement = "RUN-B-TABLE";
      expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(replacement));
      await writeFile(path, original);
      const reference = typedReport(original);
      const reader = artifactReader({ "41": path });
      const before = await captureTypedReport("task", reference, reader);
      await writeFile(path, replacement);
      const after = await captureTypedReport("task", reference, reader);
      expect(before.completeness).toBe("full");
      expect(before.reports[0]!.body).toContain(original);
      expect(after.completeness).toBe("pointer-only");
      expect(after.reports[0]!.reason).toMatch(/hash|digest|sha256/i);
      expect(after.reports[0]!.body).not.toContain(replacement);
      expect(reader.calls).toEqual(["41", "41"]);
    });
  });

  test("reusing an agent name retains each run's numeric artifact rather than a stale agent file", async () => {
    await withArtifactDirectory(async (directory) => {
      const firstPath = join(directory, "41.txt");
      const secondPath = join(directory, "42.txt");
      const stalePath = join(directory, `${REPORT_AGENT}.md`);
      await writeFile(firstPath, "FIRST-RUN-TABLE");
      await writeFile(secondPath, "SECOND-RUN-TABLE");
      await writeFile(stalePath, "STALE-AGENT-REPORT");
      const reader = hostileArtifactReader({ "41": firstPath, "42": secondPath, [REPORT_AGENT]: stalePath }, directory);
      const first = await captureTypedReport("async-result", typedReport("FIRST-RUN-TABLE"), reader);
      const second = await captureTypedReport("async-result", typedReport("SECOND-RUN-TABLE", "42", "another-run"), reader);
      const replay = await captureTypedReport("async-result", typedReport("FIRST-RUN-TABLE"), reader);
      for (const capture of [first, second, replay]) {
        expect(capture.completeness).toBe("full");
        expect(capture.reports[0]!.work.agentId).toBe(REPORT_AGENT);
        expect(capture.reports[0]!.body).not.toContain("STALE-AGENT-REPORT");
      }
      expect(first.reports[0]!.body).toContain("FIRST-RUN-TABLE");
      expect(second.reports[0]!.body).toContain("SECOND-RUN-TABLE");
      expect(second.reports[0]!.body).not.toContain("FIRST-RUN-TABLE");
      expect(replay.reports[0]!.body).toContain("FIRST-RUN-TABLE");
      expect(replay.reports[0]!.body).not.toContain("SECOND-RUN-TABLE");
      expect(reader.calls).toEqual(["41", "42", "41"]);
      expect(reader.directoryAccesses()).toBe(0);
    });
  });
});

describe("typed task report isolation and incomplete evidence", () => {
  for (const source of REPORT_PATHS) {
    test(`${source}: mixed members resolve only their own snapshots and retain individual completeness`, async () => {
      await withArtifactDirectory(async (directory) => {
        const firstPath = join(directory, "41.txt");
        const secondPath = join(directory, "42.txt");
        await writeFile(firstPath, "ALPHA-TABLE");
        await writeFile(secondPath, "BETA-TABLE");
        const reader = artifactReader({ "41": firstPath, "42": secondPath });
        const members = [
          { name: "Alpha", report: typedReport("ALPHA-TABLE") },
          { name: "Beta", report: typedReport("BETA-TABLE", "42", "beta-run") },
          { name: "Missing", report: typedReport("MISSING-TABLE", "43", "missing-run") },
        ];
        const capture = source === "wait"
          ? await captureWaitReports({
            ...waitResult(members.map(({ name, report }) => ({ id: `bg_${name}`, type: "task", status: "completed", label: name,
              agentUrlId: `0-${name}`, resultText: `${name}: ${PREVIOUS_MESSAGE}`, report }))),
            timestamp: TIMESTAMP, sessionManager: reader,
          })
          : await captureWorkReports({
            source, timestamp: TIMESTAMP, text: "Three task reports", sessionManager: reader,
            details: source === "task"
              ? { results: members.map(({ name, report }) => ({ id: `0-${name}`, agent: name, report,
                output: `${name}: ${PREVIOUS_MESSAGE}`, exitCode: 0, truncated: false })) }
              : { jobs: members.map(({ name, report }) => ({ jobId: `bg_${name}`, type: "task", status: "completed",
                label: name, agentId: `0-${name}`, report })) },
          });
        expect(capture.completeness).toBe("pointer-only");
        expect(capture.reports.map((report) => report.work.name)).toEqual(["Alpha", "Beta", "Missing"]);
        expect(capture.reports.map((report) => report.work.agentId)).toEqual(["0-Alpha", "0-Beta", "0-Missing"]);
        expect(capture.reports.map((report) => report.work.completeness)).toEqual(["full", "full", "pointer-only"]);
        expect(capture.reports[0]!.body).toContain("ALPHA-TABLE");
        expect(capture.reports[0]!.body).not.toContain("BETA-TABLE");
        expect(capture.reports[1]!.body).toContain("BETA-TABLE");
        expect(capture.reports[1]!.body).not.toContain("ALPHA-TABLE");
        expect(capture.reports[2]!.body).not.toContain("ALPHA-TABLE");
        expect(capture.reports[2]!.body).not.toContain("BETA-TABLE");
        expect(capture.reports[2]!.body).not.toContain("MISSING-TABLE");
        expect(capture.reason).toBe(capture.reports[2]!.reason);
        expect(capture.reason).toContain("unavailable");
        expect(reader.calls).toEqual(["41", "42", "43"]);
      });
    });

    test(`${source}: a readable partial snapshot remains pointer-only`, async () => {
      await withArtifactDirectory(async (directory) => {
        const path = join(directory, "41.txt");
        await writeFile(path, SUBSTANTIVE_TABLE);
        const reader = artifactReader({ "41": path });
        const capture = await captureTypedReport(source, { ...typedReport(SUBSTANTIVE_TABLE), status: "partial", reason: "failed" }, reader);
        expect(capture.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.body).toContain(SUBSTANTIVE_TABLE);
        expect(capture.reports[0]!.reason).toMatch(/partial|failed/);
        expect(capture.reason).toBe(capture.reports[0]!.reason);
        expect(reader.calls).toEqual(["41"]);
      });
    });

    test(`${source}: an otherwise complete artifact cannot promote schema-invalid output`, async () => {
      await withArtifactDirectory(async (directory) => {
        const path = join(directory, "41.txt");
        await writeFile(path, SUBSTANTIVE_TABLE);
        const reader = artifactReader({ "41": path });
        const capture = await captureTypedReport(source, typedReport(SUBSTANTIVE_TABLE), reader, {
          structured: { source: "task", mode: "strict", status: "invalid", data: { partial: "INVALID-SCHEMA-EVIDENCE" }, error: "missing required field" },
        });
        expect(capture.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.reason).toMatch(/validation|schema/);
        expect(capture.reports[0]!.body).toContain(SUBSTANTIVE_TABLE);
        expect(capture.reports[0]!.body).toContain("INVALID-SCHEMA-EVIDENCE");
        expect(reader.calls).toEqual(["41"]);
      });
    });
  }

  for (const reason of ["failed", "aborted", "schema-invalid", "too-large", "storage-unavailable", "storage-failed", "empty", "history-unavailable"]) {
    test(`partial without an artifact preserves the host's ${reason} reason`, async () => {
      const reader = artifactReader({});
      const capture = await captureTypedReport("task", { version: 1, runId: REPORT_RUN, status: "partial", reason }, reader);
      expect(capture.completeness).toBe("pointer-only");
      expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
      expect(capture.reports[0]!.reason).toContain(reason);
      expect(capture.reports[0]!.body).toBe(`${PREVIOUS_MESSAGE}\n\n${PREVIOUS_MESSAGE}`);
      expect(reader.calls).toEqual([]);
    });
  }

  test("body URLs in a typed snapshot never trigger recursive artifact or agent hydration", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "41.txt");
      const forbidden = join(directory, "42.txt");
      const body = `${SUBSTANTIVE_TABLE}\n[other](artifact://42) agent://${REPORT_AGENT} https://example.invalid/report file:///etc/passwd\n<preview full-output="agent://${REPORT_AGENT}">literal quoted syntax</preview>\nFull output: artifact://42`;
      await writeFile(path, body);
      await writeFile(forbidden, "UNADMITTED-BODY-REPORT");
      const reader = hostileArtifactReader({ "41": path, "42": forbidden, [REPORT_AGENT]: forbidden }, directory);
      const capture = await captureTypedReport("task", typedReport(body), reader);
      expect(capture.completeness).toBe("full");
      expect(capture.reports[0]!.body).toContain(body);
      expect(capture.reports[0]!.body).not.toContain("UNADMITTED-BODY-REPORT");
      expect(reader.calls).toEqual(["41"]);
      expect(reader.directoryAccesses()).toBe(0);
    });
  });
});

describe("typed report bounded regular UTF-8 files", () => {
  test("an exactly 4 MiB UTF-8 snapshot is recovered through its last byte", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "41.txt");
      const body = `${"é".repeat((REPORT_BYTE_LIMIT - 4) / 2)}LAST`;
      const reference = typedReport(body);
      expect(reference.artifact.bytes).toBe(REPORT_BYTE_LIMIT);
      await writeFile(path, body);
      const reader = artifactReader({ "41": path });
      const capture = await captureTypedReport("task", reference, reader);
      expect(capture.completeness).toBe("full");
      expect(capture.reports[0]!.body.endsWith(body)).toBe(true);
      expect(capture.reports[0]!.reason).toBeUndefined();
      expect(reader.calls).toEqual(["41"]);
    });
  });

  test("a real 4 MiB-plus-one file is rejected even when its reference understates its size", async () => {
    await withArtifactDirectory(async (directory) => {
      const path = join(directory, "41.txt");
      const body = "x".repeat(REPORT_BYTE_LIMIT + 1);
      await writeFile(path, body);
      const reference = typedReport(body);
      const reader = artifactReader({ "41": path });
      const capture = await captureTypedReport("task", { ...reference, artifact: { ...reference.artifact, bytes: REPORT_BYTE_LIMIT } }, reader);
      expect(capture.completeness).toBe("pointer-only");
      expect(capture.reports[0]!.reason).toMatch(/large|limit|byte|size/);
      expect(capture.reports[0]!.body).toBe(`${PREVIOUS_MESSAGE}\n\n${PREVIOUS_MESSAGE}`);
      expect(reader.calls).toEqual(["41"]);
    });
  });

  for (const kind of ["directory", "symlink", "invalid UTF-8", "missing file", "empty file"] as const) {
    test(`${kind} cannot become a full report even with admitted metadata`, async () => {
      await withArtifactDirectory(async (directory) => {
        const path = join(directory, "41.txt");
        let reference = typedReport(SUBSTANTIVE_TABLE);
        if (kind === "directory") await mkdir(path);
        if (kind === "symlink") {
          const target = join(directory, "target.txt");
          await writeFile(target, SUBSTANTIVE_TABLE);
          await symlink(target, path);
        }
        if (kind === "invalid UTF-8") {
          const invalid = new Uint8Array([0x63, 0xc3, 0x28]);
          await writeFile(path, invalid);
          reference = typedReport(invalid);
        }
        if (kind === "empty file") await writeFile(path, "");
        const reader = artifactReader({ "41": path });
        const capture = await captureTypedReport("task", reference, reader);
        expect(capture.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
        expect(capture.reports[0]!.reason).toMatch(kind === "directory" || kind === "symlink"
          ? /regular|file/ : kind === "empty file" ? /byte|size|empty/ : /unreadable|UTF-8/);
        expect(capture.reason).toBe(capture.reports[0]!.reason);
        expect(capture.reports[0]!.body).toBe(`${PREVIOUS_MESSAGE}\n\n${PREVIOUS_MESSAGE}`);
        expect(capture.reports[0]!.reason).not.toContain(directory);
        expect(reader.calls).toEqual(["41"]);
      });
    });
  }
});

const taskReport = (agent: string, finding: string): string => `<task-result agent="${agent}">\n<output>\n${finding}\n</output>\n</task-result>`;

/** The names are distinct, so a lookup by label, job id or agent id each has to find the report on its own. */
const AUDIT: WaitJob = {
  id: "bg_7", type: "task", status: "completed", label: "HostCompaction", agentUrlId: "0-HostCompaction", durationMs: 4200,
  resultText: taskReport("HostCompaction", "ZEBRAFINDING the veto loops"),
};

describe("captureWaitReports", () => {
  test("a finished task job is one full report under its job id, label and agent id", async () => {
    const capture = await captureWaitReports({ ...waitResult([AUDIT]), timestamp: TIMESTAMP });
    expect(capture.completeness).toBe("full");
    expect(capture.reports).toHaveLength(1);
    const [report] = capture.reports;
    expect(report!.work).toEqual({ source: "async-result", completeness: "full", id: "bg_7", name: "HostCompaction", agentId: "0-HostCompaction" });
    expect(report!.provenance).toEqual({ type: "task", status: "completed", durationMs: 4200 });
    expect(report!.timestamp).toBe(TIMESTAMP);
    expect(report!.body).toContain("ZEBRAFINDING the veto loops");
    expect(report!.body).toContain("bg_7");
    // Everything the result said was the report: nothing is left to echo.
    expect(capture.rest).toBeUndefined();
  });

  test("beside a bash job and a running job only the task is a report, and the rest of the result remains", async () => {
    const build: WaitJob = { id: "bg_3", type: "bash", status: "completed", label: "bun run build", resultText: "BUILDLOG compiled 40 files" };
    const running: WaitJob = { id: "bg_9", type: "task", status: "running", label: "StillWorking" };
    const capture = await captureWaitReports({ ...waitResult([AUDIT, build, running]), timestamp: TIMESTAMP });
    expect(capture.reports.map((report) => report.work.id)).toEqual(["bg_7"]);
    expect(capture.reports[0]!.body).not.toContain("BUILDLOG");
    expect(capture.rest).toContain("BUILDLOG compiled 40 files");
    expect(capture.rest).toContain("bg_9");
    expect(capture.rest).not.toContain("ZEBRAFINDING");
  });

  test("two finished tasks are two reports, each with only its own output", async () => {
    const second: WaitJob = { id: "bg_8", type: "task", status: "completed", label: "RealHost", agentUrlId: "1-RealHost", resultText: taskReport("RealHost", "QUOKKAFINDING three cases") };
    const capture = await captureWaitReports({ ...waitResult([AUDIT, second]), timestamp: TIMESTAMP });
    expect(capture.reports.map((report) => report.work.name)).toEqual(["HostCompaction", "RealHost"]);
    expect(capture.reports[0]!.body).toContain("ZEBRAFINDING");
    expect(capture.reports[0]!.body).not.toContain("QUOKKAFINDING");
    expect(capture.reports[1]!.body).toContain("QUOKKAFINDING");
    expect(capture.reports[1]!.body).not.toContain("ZEBRAFINDING");
  });

  test("a job the host already delivered carries no text and is not recaptured, so its first report stays the newest", async () => {
    const delivery = waitResult([{ id: "bg_7", type: "task", status: "completed", label: "HostCompaction", agentUrlId: "0-HostCompaction" }]);
    const capture = await captureWaitReports({ ...delivery, timestamp: TIMESTAMP });
    expect(capture.reports).toEqual([]);
    expect(capture.rest).toBe(delivery.text);
  });

  test("a failed task keeps the error it delivered", async () => {
    const failed: WaitJob = { id: "bg_4", type: "task", status: "failed", label: "Crashed", errorText: "agent exited with code 1" };
    const capture = await captureWaitReports({ ...waitResult([failed]), timestamp: TIMESTAMP });
    expect(capture.reports).toHaveLength(1);
    expect(capture.reports[0]!.provenance.status).toBe("failed");
    expect(capture.reports[0]!.body).toContain("agent exited with code 1");
  });

  test("a preview of a report is never claimed as the full report", async () => {
    const reader = artifactReader({});
    const previewed: WaitJob = { ...AUDIT, resultText: nestedPreview("0-HostCompaction") };
    const capture = await captureWaitReports({ ...waitResult([previewed]), timestamp: TIMESTAMP, sessionManager: reader });
    expect(capture.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.work.completeness).toBe("pointer-only");
    expect(capture.reports[0]!.reason).toBe("the host delivered a preview; the full output is referenced only in text");
    expect(capture.reports[0]!.body).toContain("first part of the review");
    expect(reader.calls).toEqual([]);
  });

  test("a non-finite timestamp is rejected", async () => {
    await expect(captureWaitReports({ ...waitResult([AUDIT]), timestamp: Number.NaN })).rejects.toThrow("finite");
  });
});

describe("a wait result in the chat log", () => {
  const harness = new Harness();

  afterEach(async () => {
    await harness.close();
  });

  async function open(): Promise<FakeHost> {
    return (await harness.open({ flags: ALL_GATES_OFF })).host;
  }

  /**
   * One turn: the user delegates, the spawn result names no agent, the agent waits, and the wait result carries
   * `delivery`. `between` is delivered after the spawn and before the wait.
   */
  async function waitTurn(host: FakeHost, delivery: { text: string; details: Record<string, unknown> }, between: HostMessage[] = []): Promise<void> {
    const messages: HostMessage[] = [
      host.user("delegate the audit, then collect it"),
      host.assistant("spawning", { id: "t1", name: "task", arguments: {} }),
      host.toolResult("t1", "task", "Started the audit in the background"),
      ...between,
      host.assistant("waiting", { id: "t2", name: "wait", arguments: {} }),
      { ...host.toolResult("t2", "wait", delivery.text), details: delivery.details } as HostMessage,
    ];
    await host.context(messages);
    await host.fire("agent_end", { messages: [...messages, host.assistant("collected")], willContinue: false });
  }

  /** The kind of each hit a `chat_search` for `text` returned, newest first. */
  async function hitKinds(host: FakeHost, text: string): Promise<string[]> {
    const result = await host.callTool("chat_search", { text });
    return [...result.matchAll(/^\d+\|(\w+)\|/gm)].map((match) => match[1]!);
  }

  test("work(name) returns the report a wait delivered, by label, job id or agent id", async () => {
    const host = await open();
    await waitTurn(host, waitResult([AUDIT]));
    for (const name of ["HostCompaction", "bg_7", "0-HostCompaction"]) {
      expect(await host.callTool("work", { name })).toContain("ZEBRAFINDING the veto loops");
    }
  });

  test("the report is logged once, as work and not also as an echo", async () => {
    const host = await open();
    await waitTurn(host, waitResult([AUDIT]));
    expect(await hitKinds(host, "ZEBRAFINDING")).toEqual(["work"]);
  });

  test("a bash job in the same wait stays an echo that no work lookup finds, while the task report is work", async () => {
    const host = await open();
    const build: WaitJob = { id: "bg_3", type: "bash", status: "completed", label: "bun run build", resultText: "BUILDLOG compiled 40 files" };
    await waitTurn(host, waitResult([AUDIT, build]));
    expect(await hitKinds(host, "BUILDLOG")).toEqual(["echo"]);
    expect(await hitKinds(host, "ZEBRAFINDING")).toEqual(["work"]);
    expect(await host.callTool("work", { name: "HostCompaction" })).toContain("ZEBRAFINDING");
    await expect(host.callTool("work", { name: "bg_3" })).rejects.toThrow();
  });

  test("a wait that only snapshots a job the host already delivered leaves the delivered report as the work", async () => {
    const host = await open();
    const delivered = {
      role: "custom", customType: "async-result", display: true, timestamp: Date.now(),
      content: taskReport("Auditor", "QUOKKAFINDING three cases"),
      details: { jobs: [{ jobId: "bg_5", agentId: "0-Auditor", label: "Auditor", type: "task", status: "completed" }] },
    } as unknown as HostMessage;
    const snapshot = waitResult([{ id: "bg_5", type: "task", status: "completed", label: "Auditor", agentUrlId: "0-Auditor" }]);
    await waitTurn(host, snapshot, [delivered]);
    expect(await host.callTool("work", { name: "Auditor" })).toContain("QUOKKAFINDING three cases");
  });
});
