import { dump, JSON_SCHEMA } from "js-yaml";
import { validateTaskRecordChange } from "./validator";
import { TaskRecordFrontMatter } from "./types";

const REAL_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_SHA = "cccccccccccccccccccccccccccccccccccccccc";

function fileFor(fm: TaskRecordFrontMatter): string {
  return `---\n${dump(fm, { schema: JSON_SCHEMA })}---\nBody text (not parsed by the validator).\n`;
}

function baseFixture(): TaskRecordFrontMatter {
  return {
    schema_version: 1,
    task_id: "1b-orchestrator-foundation-4f2a",
    title: "Stage 1B — Git-native orchestration control plane",
    stage: "1B",
    owner_role: "CLAUDE",
    status: "PROPOSED",
    revision: 1,
    retry_of: null,
    resumes_cancelled: null,
    history: [
      {
        type: "DISCOVERY_STARTED",
        actor: "CLAUDE",
        timestamp: "2026-09-06T00:01:00Z",
      },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: {
          path: "docs/orchestrator/proposals/1B-implementation-plan.md",
          commit_sha: REAL_SHA,
        },
        timestamp: "2026-09-06T00:02:00Z",
      },
    ],
  };
}

const alwaysAncestor = () => true;
const noReferencedTask = () => undefined;

describe("validateTaskRecordChange — happy path", () => {
  it("accepts a new file with no BASE", async () => {
    const head = baseFixture();
    const report = await validateTaskRecordChange({
      path: "docs/orchestrator/tasks/1b-orchestrator-foundation-4f2a.md",
      baseContent: undefined,
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(true);
    expect(report.status).toBe("PROPOSED");
  });

  it("accepts a valid append (new decision entry) over BASE", async () => {
    const base = baseFixture();
    const head: TaskRecordFrontMatter = {
      ...base,
      status: "APPROVED",
      history: [
        ...base.history,
        {
          type: "PROPOSAL_REVIEW",
          actor: "NOAH",
          decision: "APPROVED",
          reviewed_revision: 1,
          artifact_ref: {
            path: "docs/orchestrator/proposals/1B-implementation-plan.md",
            commit_sha: REAL_SHA,
          },
          scope:
            "Option A, docs/orchestrator/, packages/orchestrator-validator approved per DEC-007",
          timestamp: "2026-09-06T00:03:00Z",
        },
      ],
    };
    const report = await validateTaskRecordChange({
      path: "docs/orchestrator/tasks/1b-orchestrator-foundation-4f2a.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(true);
    expect(report.status).toBe("APPROVED");
  });
});

describe("history mutation / deletion / reordering (append-only invariant)", () => {
  it("rejects an existing entry's actor being changed", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    (head.history[0] as any).actor = "NOAH";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "HISTORY_ENTRY_MODIFIED")).toBe(
      true,
    );
  });

  it("rejects an existing decision entry's scope being changed", async () => {
    const base: TaskRecordFrontMatter = {
      ...baseFixture(),
      status: "APPROVED",
      history: [
        ...baseFixture().history,
        {
          type: "PROPOSAL_REVIEW",
          actor: "NOAH",
          decision: "APPROVED",
          reviewed_revision: 1,
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "original scope text",
          timestamp: "2026-09-06T00:03:00Z",
        },
      ],
    };
    const head = structuredClone(base);
    (head.history[2] as any).scope = "edited scope text";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "HISTORY_ENTRY_MODIFIED")).toBe(
      true,
    );
  });

  it("rejects an entry present in BASE going missing from HEAD", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.history = [head.history[0]!]; // dropped the PROPOSAL_SUBMITTED entry
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "HISTORY_SHRUNK")).toBe(true);
  });

  it("rejects two existing entries swapped in position", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.history = [head.history[1]!, head.history[0]!];
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "HISTORY_ENTRY_MODIFIED")).toBe(
      true,
    );
  });
});

describe("backdating", () => {
  it("rejects a new entry timestamped earlier than the immediately preceding entry", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.status = "APPROVED";
    head.history.push({
      type: "PROPOSAL_REVIEW",
      actor: "NOAH",
      decision: "APPROVED",
      reviewed_revision: 1,
      artifact_ref: { path: "x", commit_sha: REAL_SHA },
      scope: "approved, but backdated",
      timestamp: "2026-09-06T00:00:30Z", // earlier than the 00:02:00 entry before it
    });
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(
      report.issues.some((i) => i.code === "TIMESTAMP_NOT_INCREASING"),
    ).toBe(true);
  });
});

describe("terminal mutation", () => {
  function doneFixture(): TaskRecordFrontMatter {
    return {
      schema_version: 1,
      task_id: "1b-x-aaaa",
      title: "t",
      stage: "1B",
      owner_role: "CLAUDE",
      status: "DONE",
      revision: 1,
      retry_of: null,
      resumes_cancelled: null,
      history: [
        {
          type: "DISCOVERY_STARTED",
          actor: "CLAUDE",
          timestamp: "2026-09-06T00:01:00Z",
        },
        {
          type: "PROPOSAL_SUBMITTED",
          actor: "CLAUDE",
          revision: 1,
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          timestamp: "2026-09-06T00:02:00Z",
        },
        {
          type: "PROPOSAL_REVIEW",
          actor: "NOAH",
          decision: "APPROVED",
          reviewed_revision: 1,
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "approved",
          timestamp: "2026-09-06T00:03:00Z",
        },
        {
          type: "IMPLEMENTATION_AUTHORIZATION",
          actor: "NOAH",
          decision: "AUTHORIZED",
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "authorized",
          timestamp: "2026-09-06T00:04:00Z",
        },
        {
          type: "IMPLEMENTATION_STARTED",
          actor: "CLAUDE",
          timestamp: "2026-09-06T00:05:00Z",
        },
        {
          type: "VERIFICATION_STARTED",
          actor: "CLAUDE",
          timestamp: "2026-09-06T00:06:00Z",
        },
        {
          type: "VERIFICATION_RESULT",
          actor: "ANTIGRAVITY",
          decision: "PASSED",
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "green",
          timestamp: "2026-09-06T00:07:00Z",
          target_state: "FINAL_REVIEW",
        },
        {
          type: "CTO_FINAL_APPROVAL",
          actor: "NOAH",
          decision: "APPROVED",
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "final",
          timestamp: "2026-09-06T00:08:00Z",
        },
      ],
    };
  }

  it("rejects any diff at all — even an apparently harmless new field — once BASE's derived status is terminal", async () => {
    const base = doneFixture();
    const head = structuredClone(base);
    (head as any).title = "a slightly nicer title";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "TERMINAL_STATE_MUTATED")).toBe(
      true,
    );
  });
});

describe("invalid approvals", () => {
  it("rejects an empty scope", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.status = "APPROVED";
    head.history.push({
      type: "PROPOSAL_REVIEW",
      actor: "NOAH",
      decision: "APPROVED",
      reviewed_revision: 1,
      artifact_ref: { path: "x", commit_sha: REAL_SHA },
      scope: "",
      timestamp: "2026-09-06T00:03:00Z",
    });
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "INVALID_SCOPE")).toBe(true);
  });

  it("rejects a generic-only scope", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.status = "APPROVED";
    head.history.push({
      type: "PROPOSAL_REVIEW",
      actor: "NOAH",
      decision: "APPROVED",
      reviewed_revision: 1,
      artifact_ref: { path: "x", commit_sha: REAL_SHA },
      scope: "approved",
      timestamp: "2026-09-06T00:03:00Z",
    });
    // "approved" is not in the blocked generic-word list (only all/everything/task/empty
    // are per §4's examples) — use one that is, to test the actual rule.
    (head.history[head.history.length - 1] as any).scope = "everything";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "INVALID_SCOPE")).toBe(true);
  });

  it("rejects a decision entry whose artifact_ref.commit_sha does not resolve to an ancestor of the PR base", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.status = "APPROVED";
    head.history.push({
      type: "PROPOSAL_REVIEW",
      actor: "NOAH",
      decision: "APPROVED",
      reviewed_revision: 1,
      artifact_ref: { path: "x", commit_sha: OTHER_SHA },
      scope: "approved on a non-ancestor SHA",
      timestamp: "2026-09-06T00:03:00Z",
    });
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: (sha: string) => sha === REAL_SHA,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(
      report.issues.some((i) => i.code === "ARTIFACT_SHA_NOT_ANCESTOR"),
    ).toBe(true);
  });
});

describe("retry_of behavior", () => {
  function failedTask(taskId: string): TaskRecordFrontMatter {
    return {
      schema_version: 1,
      task_id: taskId,
      title: "t",
      stage: "1B",
      owner_role: "CLAUDE",
      status: "FAILED",
      revision: 1,
      retry_of: null,
      resumes_cancelled: null,
      history: [
        {
          type: "DISCOVERY_STARTED",
          actor: "CLAUDE",
          timestamp: "2026-09-06T00:01:00Z",
        },
        {
          type: "PROPOSAL_SUBMITTED",
          actor: "CLAUDE",
          revision: 1,
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          timestamp: "2026-09-06T00:02:00Z",
        },
        {
          type: "PROPOSAL_REVIEW",
          actor: "NOAH",
          decision: "APPROVED",
          reviewed_revision: 1,
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "approved",
          timestamp: "2026-09-06T00:03:00Z",
        },
        {
          type: "IMPLEMENTATION_AUTHORIZATION",
          actor: "NOAH",
          decision: "AUTHORIZED",
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "authorized",
          timestamp: "2026-09-06T00:04:00Z",
        },
        {
          type: "IMPLEMENTATION_STARTED",
          actor: "CLAUDE",
          timestamp: "2026-09-06T00:05:00Z",
        },
        {
          type: "VERIFICATION_STARTED",
          actor: "CLAUDE",
          timestamp: "2026-09-06T00:06:00Z",
        },
        {
          type: "VERIFICATION_RESULT",
          actor: "ANTIGRAVITY",
          decision: "FAILED",
          artifact_ref: { path: "x", commit_sha: REAL_SHA },
          scope: "tests red",
          timestamp: "2026-09-06T00:07:00Z",
        },
      ],
    };
  }

  it("accepts a new file with retry_of pointing at a real FAILED task", async () => {
    const head = baseFixture();
    head.retry_of = "1b-old-task-dead1";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: (id) =>
        id === "1b-old-task-dead1" ? failedTask(id) : undefined,
    });
    expect(report.valid).toBe(true);
  });

  it("rejects retry_of pointing at a non-FAILED task", async () => {
    const notFailed = failedTask("1b-old-task-dead1");
    notFailed.status = "PROPOSED";
    notFailed.history = [notFailed.history[0]!, notFailed.history[1]!];
    const head = baseFixture();
    head.retry_of = "1b-old-task-dead1";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: (id) =>
        id === "1b-old-task-dead1" ? notFailed : undefined,
    });
    expect(report.valid).toBe(false);
    expect(
      report.issues.some((i) => i.code === "RETRY_OF_TARGET_NOT_FAILED"),
    ).toBe(true);
  });

  it("rejects attempting to set retry_of on an existing file via a later diff", async () => {
    const base = baseFixture();
    const head = structuredClone(base);
    head.retry_of = "1b-old-task-dead1";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: fileFor(base),
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: (id) =>
        id === "1b-old-task-dead1" ? failedTask(id) : undefined,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "RETRY_OF_CHANGED")).toBe(true);
  });
});

describe("malformed records", () => {
  it("fails closed on no front matter", async () => {
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: "Just a plain markdown file, no front matter.\n",
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MALFORMED_FILE")).toBe(true);
  });

  it("fails closed on invalid YAML", async () => {
    const content = "---\nthis: [is not, closed\n---\nbody\n";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: content,
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MALFORMED_FILE")).toBe(true);
  });

  it("fails closed on a missing required field", async () => {
    const head: any = baseFixture();
    delete head.title;
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "MISSING_FIELD")).toBe(true);
  });

  it("fails closed on an unrecognized enum value (status)", async () => {
    const head: any = baseFixture();
    head.status = "SOMETHING_MADE_UP";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
  });

  it("fails closed on an extra, unrecognized top-level key", async () => {
    const head: any = baseFixture();
    head.not_a_real_field = "surprise";
    const report = await validateTaskRecordChange({
      path: "t.md",
      baseContent: undefined,
      headContent: fileFor(head),
      isAncestorOrEqual: alwaysAncestor,
      resolveReferencedTask: noReferencedTask,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "UNKNOWN_FIELD")).toBe(true);
  });
});

// NOAH CTO code review — PR #25, PRIMARY REQUIRED FIX: schema.ts previously
// validated presence and some enums but did not constrain several known
// fields to their declared types. These tests prove the validator now
// fails closed on malformed *known* fields (not merely unknown ones), for
// every field named in the review.
describe("malformed field types (schema strictness — fail closed on known fields)", () => {
  // Values a nullable-string or plain-string field must reject outright.
  const nonStringScalars: unknown[] = [{ nested: true }, ["x"], true, 42];
  // Values a "non-negative integer" field must reject outright.
  const nonNonNegativeIntScalars: unknown[] = ["1", -1, 1.5, true, {}];

  it("rejects retry_of when set to an object, array, boolean, or number", async () => {
    for (const value of nonStringScalars) {
      const head: any = baseFixture();
      head.retry_of = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(report.issues.some((i) => i.code === "SCHEMA_VIOLATION")).toBe(
        true,
      );
    }
  });

  it("rejects resumes_cancelled when set to an object, array, boolean, or number", async () => {
    for (const value of nonStringScalars) {
      const head: any = baseFixture();
      head.resumes_cancelled = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(report.issues.some((i) => i.code === "SCHEMA_VIOLATION")).toBe(
        true,
      );
    }
  });

  it("rejects artifact_ref.path when set to an object, array, boolean, or number", async () => {
    for (const value of nonStringScalars) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.path = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_PATH"),
      ).toBe(true);
    }
  });

  it("rejects artifact_ref.commit_sha when set to an object, array, boolean, or number", async () => {
    for (const value of nonStringScalars) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.commit_sha = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_COMMIT_SHA"),
      ).toBe(true);
    }
  });

  it("rejects artifact_ref.revision when not a non-negative integer", async () => {
    for (const value of nonNonNegativeIntScalars) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.revision = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_REVISION"),
      ).toBe(true);
    }
  });

  it("rejects artifact_ref.pr_url when set to an object, array, boolean, or number", async () => {
    for (const value of nonStringScalars) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.pr_url = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_PR_URL"),
      ).toBe(true);
    }
  });

  it("rejects artifact_ref.ci_run_ref when set to an object, array, boolean, or number", async () => {
    for (const value of nonStringScalars) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.ci_run_ref = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_CI_RUN_REF"),
      ).toBe(true);
    }
  });

  it("rejects artifact_ref.checks when not an array of strings", async () => {
    const malformedChecks: unknown[] = ["not-an-array", 1, true, {}, ["ok", 2]];
    for (const value of malformedChecks) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.checks = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_CHECKS"),
      ).toBe(true);
    }
  });

  it("rejects artifact_ref.note when not a string", async () => {
    const malformedNotes: unknown[] = [1, true, {}, ["x"]];
    for (const value of malformedNotes) {
      const head: any = baseFixture();
      head.history[1].artifact_ref.note = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "ARTIFACT_REF_INVALID_NOTE"),
      ).toBe(true);
    }
  });

  it("rejects a plain history entry's revision when not a non-negative integer", async () => {
    for (const value of nonNonNegativeIntScalars) {
      const head: any = baseFixture();
      head.history[1].revision = value;
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(report.issues.some((i) => i.code === "INVALID_REVISION")).toBe(
        true,
      );
    }
  });

  it("rejects reviewed_revision when not a non-negative integer", async () => {
    for (const value of nonNonNegativeIntScalars) {
      const head: any = baseFixture();
      head.status = "APPROVED";
      head.history.push({
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: value,
        artifact_ref: { path: "x", commit_sha: REAL_SHA },
        scope: "approved despite malformed reviewed_revision",
        timestamp: "2026-09-06T00:03:00Z",
      });
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(
        report.issues.some((i) => i.code === "INVALID_REVIEWED_REVISION"),
      ).toBe(true);
    }
  });

  it("rejects supersedes when neither null nor a non-negative integer index", async () => {
    const malformedSupersedes: unknown[] = ["1", -1, 1.5, true, {}, ["x"]];
    for (const value of malformedSupersedes) {
      const head: any = baseFixture();
      head.status = "APPROVED";
      head.history.push({
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 1,
        artifact_ref: { path: "x", commit_sha: REAL_SHA },
        scope: "approved despite malformed supersedes",
        timestamp: "2026-09-06T00:03:00Z",
        supersedes: value,
      });
      const report = await validateTaskRecordChange({
        path: "t.md",
        baseContent: undefined,
        headContent: fileFor(head),
        isAncestorOrEqual: alwaysAncestor,
        resolveReferencedTask: noReferencedTask,
      });
      expect(report.valid).toBe(false);
      expect(report.issues.some((i) => i.code === "INVALID_SUPERSEDES")).toBe(
        true,
      );
    }
  });
});
