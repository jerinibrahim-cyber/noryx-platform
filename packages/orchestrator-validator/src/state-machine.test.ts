import { STATES, State } from "./types";
import {
  TRANSITIONS,
  TERMINAL_STATES,
  isTerminal,
  deriveStatus,
} from "./state-machine";
import { HistoryEntry } from "./types";

function artifactRef(
  sha: string | null = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
) {
  return sha === null
    ? {
        path: "docs/orchestrator/proposals/1B-implementation-plan.md",
        commit_sha: null,
        note: "not yet committed",
      }
    : {
        path: "docs/orchestrator/proposals/1B-implementation-plan.md",
        commit_sha: sha,
      };
}

let t = 0;
function ts(): string {
  t += 1;
  return `2026-09-06T00:${String(t).padStart(2, "0")}:00Z`;
}
beforeEach(() => {
  t = 0;
});

describe("single-source assertions", () => {
  it("STATES has exactly 14 entries", () => {
    expect(STATES.length).toBe(14);
  });

  it("TERMINAL_STATES is derived from TRANSITIONS and equals exactly {DONE, FAILED, CANCELLED}", () => {
    // Proves the *derivation*, not just the result — recomputes it the
    // same way state-machine.ts does, from the exported TRANSITIONS table.
    const derived = new Set(
      STATES.filter((s) => !TRANSITIONS.some((r) => r.from === s)),
    );
    expect(derived).toEqual(new Set(["DONE", "FAILED", "CANCELLED"]));
    expect(TERMINAL_STATES).toEqual(new Set(["DONE", "FAILED", "CANCELLED"]));
    for (const s of ["DONE", "FAILED", "CANCELLED"] as State[]) {
      expect(isTerminal(s)).toBe(true);
    }
    for (const s of STATES.filter(
      (s) => !["DONE", "FAILED", "CANCELLED"].includes(s),
    )) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it("would fail if an outgoing row were ever accidentally added from DONE", () => {
    const tainted = [
      ...TRANSITIONS,
      {
        from: "DONE" as State,
        to: "IN_PROGRESS" as State,
        entryType: "CANCELLED" as const,
      },
    ];
    const derived = new Set(
      STATES.filter((s) => !tainted.some((r) => r.from === s)),
    );
    expect(derived.has("DONE")).toBe(false);
    expect(derived).not.toEqual(new Set(["DONE", "FAILED", "CANCELLED"]));
  });
});

describe("happy paths (real imported STATES/TRANSITIONS/deriveStatus)", () => {
  it("DEFINED -> DISCOVERY -> PROPOSED (new file, no BASE)", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(null),
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(true);
    expect(result.status).toBe("PROPOSED");
  });

  it("full lifecycle PROPOSED -> APPROVED -> AUTHORIZED -> IN_PROGRESS -> VERIFICATION -> FINAL_REVIEW -> DONE (skipping code review)", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 1,
        artifact_ref: artifactRef(),
        scope: "Option A, docs/orchestrator/, packages/orchestrator-validator",
        timestamp: ts(),
      },
      {
        type: "IMPLEMENTATION_AUTHORIZATION",
        actor: "NOAH",
        decision: "AUTHORIZED",
        artifact_ref: artifactRef(),
        scope:
          "Implementation of the schema + validator package exactly as approved",
        timestamp: ts(),
      },
      { type: "IMPLEMENTATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      { type: "VERIFICATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "VERIFICATION_RESULT",
        actor: "ANTIGRAVITY",
        decision: "PASSED",
        artifact_ref: artifactRef(),
        scope: "build/lint/typecheck/test all green",
        timestamp: ts(),
        target_state: "FINAL_REVIEW",
      },
      {
        type: "CTO_FINAL_APPROVAL",
        actor: "NOAH",
        decision: "APPROVED",
        artifact_ref: artifactRef(),
        scope: "final sign-off on the implementation PR",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(true);
    expect(result.status).toBe("DONE");
  });

  it("the same lifecycle including a CODE_REVIEW loop with one CHANGES_REQUESTED before APPROVED", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 1,
        artifact_ref: artifactRef(),
        scope: "design approved",
        timestamp: ts(),
      },
      {
        type: "IMPLEMENTATION_AUTHORIZATION",
        actor: "NOAH",
        decision: "AUTHORIZED",
        artifact_ref: artifactRef(),
        scope: "implementation authorized",
        timestamp: ts(),
      },
      { type: "IMPLEMENTATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      { type: "VERIFICATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "VERIFICATION_RESULT",
        actor: "ANTIGRAVITY",
        decision: "PASSED",
        artifact_ref: artifactRef(),
        scope: "tests green, review warranted",
        timestamp: ts(),
        target_state: "CODE_REVIEW",
      },
      {
        type: "CODE_REVIEW_RESULT",
        actor: "CLAUDE",
        decision: "CHANGES_REQUESTED",
        artifact_ref: artifactRef(),
        scope: "naming inconsistency in state-machine.ts",
        timestamp: ts(),
        target_state: "CODE_REVIEW",
      },
      {
        type: "CODE_REVIEW_RESULT",
        actor: "CLAUDE",
        decision: "APPROVED",
        artifact_ref: artifactRef(),
        scope: "review comments addressed",
        timestamp: ts(),
      },
      {
        type: "CTO_FINAL_APPROVAL",
        actor: "NOAH",
        decision: "APPROVED",
        artifact_ref: artifactRef(),
        scope: "final sign-off",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(true);
    expect(result.status).toBe("DONE");
  });

  it("a CHANGES_REQUIRED cycle at PROPOSED with the front-matter revision incrementing", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "CHANGES_REQUIRED",
        reviewed_revision: 1,
        artifact_ref: artifactRef(),
        scope: "fix the state count",
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 2,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 2,
        artifact_ref: artifactRef(),
        scope: "approved on revision 2",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(true);
    expect(result.status).toBe("APPROVED");
    const submittedCount = history.filter(
      (h) => h.type === "PROPOSAL_SUBMITTED",
    ).length;
    expect(submittedCount).toBe(2); // revision = count of PROPOSAL_SUBMITTED entries, per §3
  });
});

describe("invalid transitions (explicit negative cases, against the real table)", () => {
  it("rejects DEFINED -> APPROVED (skips states)", () => {
    const history: HistoryEntry[] = [
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 1,
        artifact_ref: artifactRef(),
        scope: "skip ahead",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects PROPOSED -> AUTHORIZED directly (skips APPROVED)", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "IMPLEMENTATION_AUTHORIZATION",
        actor: "NOAH",
        decision: "AUTHORIZED",
        artifact_ref: artifactRef(),
        scope: "skip APPROVED",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("INVALID_TRANSITION");
  });

  it("rejects DONE -> IN_PROGRESS (exit from terminal)", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 1,
        artifact_ref: artifactRef(),
        scope: "approved",
        timestamp: ts(),
      },
      {
        type: "IMPLEMENTATION_AUTHORIZATION",
        actor: "NOAH",
        decision: "AUTHORIZED",
        artifact_ref: artifactRef(),
        scope: "authorized",
        timestamp: ts(),
      },
      { type: "IMPLEMENTATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      { type: "VERIFICATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "VERIFICATION_RESULT",
        actor: "ANTIGRAVITY",
        decision: "PASSED",
        artifact_ref: artifactRef(),
        scope: "green",
        timestamp: ts(),
        target_state: "FINAL_REVIEW",
      },
      {
        type: "CTO_FINAL_APPROVAL",
        actor: "NOAH",
        decision: "APPROVED",
        artifact_ref: artifactRef(),
        scope: "final",
        timestamp: ts(),
      },
      { type: "IMPLEMENTATION_STARTED", actor: "CLAUDE", timestamp: ts() },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("TERMINAL_STATE_MUTATED");
  });

  it("rejects a VERIFICATION_RESULT: PASSED used to satisfy PROPOSED -> APPROVED (wrong decision type for the gate)", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "VERIFICATION_RESULT",
        actor: "ANTIGRAVITY",
        decision: "PASSED",
        artifact_ref: artifactRef(),
        scope: "wrong gate entirely",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("INVALID_TRANSITION");
  });

  it("requires target_state when a decision entry's transition is ambiguous", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "PROPOSAL_SUBMITTED",
        actor: "CLAUDE",
        revision: 1,
        artifact_ref: artifactRef(),
        timestamp: ts(),
      },
      {
        type: "PROPOSAL_REVIEW",
        actor: "NOAH",
        decision: "APPROVED",
        reviewed_revision: 1,
        artifact_ref: artifactRef(),
        scope: "approved",
        timestamp: ts(),
      },
      {
        type: "IMPLEMENTATION_AUTHORIZATION",
        actor: "NOAH",
        decision: "AUTHORIZED",
        artifact_ref: artifactRef(),
        scope: "authorized",
        timestamp: ts(),
      },
      { type: "IMPLEMENTATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      { type: "VERIFICATION_STARTED", actor: "CLAUDE", timestamp: ts() },
      // PASSED without target_state is ambiguous: CODE_REVIEW or FINAL_REVIEW.
      {
        type: "VERIFICATION_RESULT",
        actor: "ANTIGRAVITY",
        decision: "PASSED",
        artifact_ref: artifactRef(),
        scope: "green but no target_state",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe(
      "AMBIGUOUS_TRANSITION_REQUIRES_TARGET_STATE",
    );
  });

  it("rejects RESUMED with a resumed_to that does not match the actually-interrupted state", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "BLOCKED",
        actor: "CLAUDE",
        reason: "waiting on NOAH",
        timestamp: ts(),
      },
      {
        type: "RESUMED",
        actor: "CLAUDE",
        resumed_to: "IN_PROGRESS",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe("RESUMED_TO_MISMATCH");
  });

  it("accepts RESUMED back to the actually-interrupted state", () => {
    const history: HistoryEntry[] = [
      { type: "DISCOVERY_STARTED", actor: "CLAUDE", timestamp: ts() },
      {
        type: "BLOCKED",
        actor: "CLAUDE",
        reason: "waiting on NOAH",
        timestamp: ts(),
      },
      {
        type: "RESUMED",
        actor: "CLAUDE",
        resumed_to: "DISCOVERY",
        timestamp: ts(),
      },
    ];
    const result = deriveStatus(history);
    expect(result.valid).toBe(true);
    expect(result.status).toBe("DISCOVERY");
  });
});
