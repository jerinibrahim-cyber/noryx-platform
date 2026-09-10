/**
 * THE single authoritative representation of states, transitions, decision
 * gates, and terminal-state derivation for the NOAH orchestration task
 * schema (Stage 1B), per docs/orchestrator/proposals/1B-implementation-plan.md
 * §5/§6 ("Single authoritative representation (locked requirement)").
 *
 * Nothing outside this file independently encodes a transition, a decision
 * gate, or a terminal-state list. docs/orchestrator/SCHEMA.md deliberately
 * does not reprint the transition table — it points here.
 */
import {
  STATES,
  State,
  HistoryEntry,
  HistoryEntryType,
  DecisionType,
  isDecisionEntry,
  isPlainEntry,
} from "./types";

export interface TransitionRule {
  from: State;
  to: State;
  entryType: HistoryEntryType;
  requiredDecision?: { type: DecisionType; decision: string };
}

/**
 * THE single, authoritative transition table — every row from §5.2, and
 * nowhere else, EXCEPT the "(any non-terminal) -> CANCELLED" rows, which
 * are appended below and derived from this array itself rather than from
 * a second, independently maintained state list (§6 item 2 / NOAH PR #25
 * code review — "SINGLE SOURCE OF TRUTH"). A small number of rows fill
 * gaps the approved plan left open (an unnamed plain-entry type, or a
 * decision value with no explicitly stated destination) — each such row
 * is commented with the gap it fills; see docs/orchestrator/SCHEMA.md for
 * the full rationale.
 */
const CORE_TRANSITIONS: TransitionRule[] = [
  // DEFINED -> DISCOVERY
  { from: "DEFINED", to: "DISCOVERY", entryType: "DISCOVERY_STARTED" },

  // DISCOVERY -> PROPOSED / BLOCKED
  { from: "DISCOVERY", to: "PROPOSED", entryType: "PROPOSAL_SUBMITTED" },
  { from: "DISCOVERY", to: "BLOCKED", entryType: "BLOCKED" },

  // PROPOSED -> PROPOSED (CHANGES_REQUIRED) / APPROVED / CANCELLED (plain)
  {
    from: "PROPOSED",
    to: "PROPOSED",
    entryType: "PROPOSAL_REVIEW",
    requiredDecision: { type: "PROPOSAL_REVIEW", decision: "CHANGES_REQUIRED" },
  },
  {
    from: "PROPOSED",
    to: "APPROVED",
    entryType: "PROPOSAL_REVIEW",
    requiredDecision: { type: "PROPOSAL_REVIEW", decision: "APPROVED" },
  },
  // GAP FILL: §5.2's table does not list a row for a revised proposal being
  // resubmitted after CHANGES_REQUIRED, but §5.6 explicitly describes this
  // exact case ("the next PROPOSAL_SUBMITTED entry's revision increments by
  // one") — a self-loop on PROPOSED, mirroring the CHANGES_REQUIRED row
  // immediately above it.
  { from: "PROPOSED", to: "PROPOSED", entryType: "PROPOSAL_SUBMITTED" },
  // GAP FILL: PROPOSAL_REVIEW: REJECTED has no destination in §5.2's table.
  // A rejected proposal is treated as a hard stop, mapped to CANCELLED —
  // consistent with how CTO_FINAL_APPROVAL: REJECTED maps to a terminal
  // state elsewhere in the same table.
  {
    from: "PROPOSED",
    to: "CANCELLED",
    entryType: "PROPOSAL_REVIEW",
    requiredDecision: { type: "PROPOSAL_REVIEW", decision: "REJECTED" },
  },

  // APPROVED -> AUTHORIZED / APPROVED (WITHHELD, no-op) / DEFERRED
  {
    from: "APPROVED",
    to: "AUTHORIZED",
    entryType: "IMPLEMENTATION_AUTHORIZATION",
    requiredDecision: {
      type: "IMPLEMENTATION_AUTHORIZATION",
      decision: "AUTHORIZED",
    },
  },
  // GAP FILL: IMPLEMENTATION_AUTHORIZATION: WITHHELD has no destination in
  // §5.2's table. Modeled the same way §5.6 already models
  // PROPOSAL_REVIEW: CHANGES_REQUIRED — a recorded decision that leaves
  // status unchanged, not a move to a new state.
  {
    from: "APPROVED",
    to: "APPROVED",
    entryType: "IMPLEMENTATION_AUTHORIZATION",
    requiredDecision: {
      type: "IMPLEMENTATION_AUTHORIZATION",
      decision: "WITHHELD",
    },
  },
  { from: "APPROVED", to: "DEFERRED", entryType: "DEFERRED" },

  // AUTHORIZED -> IN_PROGRESS (plain entry; see PLAIN_ENTRY_TYPES gap-fill note)
  {
    from: "AUTHORIZED",
    to: "IN_PROGRESS",
    entryType: "IMPLEMENTATION_STARTED",
  },

  // IN_PROGRESS -> VERIFICATION (plain) / BLOCKED / DEFERRED
  {
    from: "IN_PROGRESS",
    to: "VERIFICATION",
    entryType: "VERIFICATION_STARTED",
  },
  { from: "IN_PROGRESS", to: "BLOCKED", entryType: "BLOCKED" },
  { from: "IN_PROGRESS", to: "DEFERRED", entryType: "DEFERRED" },

  // VERIFICATION -> CODE_REVIEW / FINAL_REVIEW (both PASSED; disambiguated
  // via target_state, see types.ts) / FAILED / BLOCKED
  {
    from: "VERIFICATION",
    to: "CODE_REVIEW",
    entryType: "VERIFICATION_RESULT",
    requiredDecision: { type: "VERIFICATION_RESULT", decision: "PASSED" },
  },
  {
    from: "VERIFICATION",
    to: "FINAL_REVIEW",
    entryType: "VERIFICATION_RESULT",
    requiredDecision: { type: "VERIFICATION_RESULT", decision: "PASSED" },
  },
  {
    from: "VERIFICATION",
    to: "FAILED",
    entryType: "VERIFICATION_RESULT",
    requiredDecision: { type: "VERIFICATION_RESULT", decision: "FAILED" },
  },
  { from: "VERIFICATION", to: "BLOCKED", entryType: "BLOCKED" },

  // CODE_REVIEW -> CODE_REVIEW / FAILED (both CHANGES_REQUESTED,
  // disambiguated via target_state) / FINAL_REVIEW / BLOCKED
  {
    from: "CODE_REVIEW",
    to: "CODE_REVIEW",
    entryType: "CODE_REVIEW_RESULT",
    requiredDecision: {
      type: "CODE_REVIEW_RESULT",
      decision: "CHANGES_REQUESTED",
    },
  },
  {
    from: "CODE_REVIEW",
    to: "FAILED",
    entryType: "CODE_REVIEW_RESULT",
    requiredDecision: {
      type: "CODE_REVIEW_RESULT",
      decision: "CHANGES_REQUESTED",
    },
  },
  {
    from: "CODE_REVIEW",
    to: "FINAL_REVIEW",
    entryType: "CODE_REVIEW_RESULT",
    requiredDecision: { type: "CODE_REVIEW_RESULT", decision: "APPROVED" },
  },
  { from: "CODE_REVIEW", to: "BLOCKED", entryType: "BLOCKED" },

  // FINAL_REVIEW -> DONE / FAILED / BLOCKED
  {
    from: "FINAL_REVIEW",
    to: "DONE",
    entryType: "CTO_FINAL_APPROVAL",
    requiredDecision: { type: "CTO_FINAL_APPROVAL", decision: "APPROVED" },
  },
  {
    from: "FINAL_REVIEW",
    to: "FAILED",
    entryType: "CTO_FINAL_APPROVAL",
    requiredDecision: { type: "CTO_FINAL_APPROVAL", decision: "REJECTED" },
  },
  { from: "FINAL_REVIEW", to: "BLOCKED", entryType: "BLOCKED" },

  // BLOCKED -> DEFERRED, and RESUMED back to each state that can reach BLOCKED
  { from: "BLOCKED", to: "DEFERRED", entryType: "DEFERRED" },
  { from: "BLOCKED", to: "DISCOVERY", entryType: "RESUMED" },
  { from: "BLOCKED", to: "IN_PROGRESS", entryType: "RESUMED" },
  { from: "BLOCKED", to: "VERIFICATION", entryType: "RESUMED" },
  { from: "BLOCKED", to: "CODE_REVIEW", entryType: "RESUMED" },
  { from: "BLOCKED", to: "FINAL_REVIEW", entryType: "RESUMED" },

  // DEFERRED -> RESUMED back to each state that can reach DEFERRED directly
  { from: "DEFERRED", to: "APPROVED", entryType: "RESUMED" },
  { from: "DEFERRED", to: "IN_PROGRESS", entryType: "RESUMED" },
];

/**
 * The states eligible for "(any non-terminal) -> CANCELLED, with reason"
 * are DERIVED from CORE_TRANSITIONS by the exact same "has at least one
 * outgoing row" rule used below to derive TERMINAL_STATES — applied here
 * to the pre-cancellation table, so DONE/FAILED/CANCELLED (which have no
 * outgoing rows in CORE_TRANSITIONS either) are naturally excluded without
 * a second, independently maintained list of non-terminal states.
 */
const CANCEL_ELIGIBLE_STATES: readonly State[] = STATES.filter((s) =>
  CORE_TRANSITIONS.some((t) => t.from === s),
);

/**
 * THE single, authoritative transition table: CORE_TRANSITIONS plus the
 * derived cancellation rows. Nothing else in this module (or outside it)
 * independently encodes a transition, a decision gate, or a terminal- or
 * cancel-eligible-state list.
 */
export const TRANSITIONS: TransitionRule[] = [
  ...CORE_TRANSITIONS,
  // (any non-terminal) -> CANCELLED, with reason (plain entry)
  ...CANCEL_ELIGIBLE_STATES.map((from): TransitionRule => ({
    from,
    to: "CANCELLED",
    entryType: "CANCELLED",
  })),
];

/**
 * Terminal states are DERIVED, not hand-listed — a state with zero
 * outgoing rows in TRANSITIONS is terminal, by construction, so "the
 * terminal list" and "the transition table" cannot drift apart because
 * there is only one of them.
 */
export const TERMINAL_STATES: ReadonlySet<State> = new Set(
  STATES.filter((s) => !TRANSITIONS.some((t) => t.from === s)),
);

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.has(state);
}

export type TransitionErrorCode =
  | "TIMESTAMP_NOT_INCREASING"
  | "TERMINAL_STATE_MUTATED"
  | "RESUMED_NOT_FROM_INTERRUPT"
  | "RESUMED_TO_MISMATCH"
  | "INVALID_TRANSITION"
  | "AMBIGUOUS_TRANSITION_REQUIRES_TARGET_STATE"
  | "INVALID_TARGET_STATE"
  | "TARGET_STATE_MISMATCH";

export interface TransitionError {
  index: number;
  code: TransitionErrorCode;
  message: string;
}

export interface DeriveResult {
  status: State;
  valid: boolean;
  errors: TransitionError[];
}

/**
 * THE one function replaying a task's history against TRANSITIONS. This
 * single function IS transition validation, approval-gate validation, and
 * status derivation — there is no second copy of any of the three
 * anywhere (§6 item 2).
 *
 * Field-level checks (required `reason`, non-generic `scope`, artifact-SHA
 * ancestry, secret-pattern linting) are deliberately NOT this function's
 * job — those are separate checks per §6's own numbered list (items 1, 7,
 * 8) and live in schema.ts / history-validation.ts.
 */
export function deriveStatus(history: readonly HistoryEntry[]): DeriveResult {
  let current: State = "DEFINED";
  let suspendedFrom: State | null = null;
  let prevTimestamp: string | null = null;

  for (let index = 0; index < history.length; index++) {
    // Always in bounds — index is driven by the same array's length.
    const entry = history[index]!;

    if (prevTimestamp !== null && !(entry.timestamp > prevTimestamp)) {
      return fail(
        current,
        index,
        "TIMESTAMP_NOT_INCREASING",
        `Entry ${index} timestamp "${entry.timestamp}" does not strictly increase over the previous entry's "${prevTimestamp}".`,
      );
    }
    prevTimestamp = entry.timestamp;

    if (isTerminal(current)) {
      return fail(
        current,
        index,
        "TERMINAL_STATE_MUTATED",
        `Entry ${index} ("${entry.type}") appears after the task reached terminal state ${current}; terminal states are frozen.`,
      );
    }

    if (entry.type === "RESUMED") {
      if (current !== "BLOCKED" && current !== "DEFERRED") {
        return fail(
          current,
          index,
          "RESUMED_NOT_FROM_INTERRUPT",
          `RESUMED entry at index ${index} found while status is ${current}, not BLOCKED or DEFERRED.`,
        );
      }
      const resumedTo =
        (isPlainEntry(entry) ? entry.resumed_to : undefined) ?? null;
      if (resumedTo === null || resumedTo !== suspendedFrom) {
        return fail(
          current,
          index,
          "RESUMED_TO_MISMATCH",
          `RESUMED entry at index ${index} has resumed_to=${String(resumedTo)}, expected the interrupted state ${String(suspendedFrom)}.`,
        );
      }
      const row = TRANSITIONS.find(
        (t) =>
          t.from === current && t.to === resumedTo && t.entryType === "RESUMED",
      );
      if (!row) {
        return fail(
          current,
          index,
          "INVALID_TRANSITION",
          `No allowed RESUMED transition from ${current} to ${resumedTo}.`,
        );
      }
      current = resumedTo;
      suspendedFrom = null;
      continue;
    }

    let candidates: TransitionRule[];
    if (isDecisionEntry(entry)) {
      candidates = TRANSITIONS.filter(
        (t) =>
          t.from === current &&
          t.entryType === entry.type &&
          t.requiredDecision?.decision === entry.decision,
      );
    } else {
      candidates = TRANSITIONS.filter(
        (t) =>
          t.from === current &&
          t.entryType === entry.type &&
          !t.requiredDecision,
      );
    }

    if (candidates.length === 0) {
      const decisionSuffix = isDecisionEntry(entry)
        ? `: ${entry.decision}`
        : "";
      return fail(
        current,
        index,
        "INVALID_TRANSITION",
        `No allowed transition from ${current} via ${entry.type}${decisionSuffix} (entry index ${index}).`,
      );
    }

    let target: State;
    if (candidates.length === 1) {
      target = candidates[0]!.to;
      if (
        isDecisionEntry(entry) &&
        entry.target_state &&
        entry.target_state !== target
      ) {
        return fail(
          current,
          index,
          "TARGET_STATE_MISMATCH",
          `Entry ${index} target_state=${entry.target_state} does not match the only allowed destination ${target}.`,
        );
      }
    } else {
      const requestedTarget = isDecisionEntry(entry)
        ? entry.target_state
        : undefined;
      if (!requestedTarget) {
        return fail(
          current,
          index,
          "AMBIGUOUS_TRANSITION_REQUIRES_TARGET_STATE",
          `Entry ${index} (${entry.type}${isDecisionEntry(entry) ? ": " + entry.decision : ""}) from ${current} has more than one allowed destination (${candidates.map((c) => c.to).join(", ")}) and must set target_state.`,
        );
      }
      const match = candidates.find((c) => c.to === requestedTarget);
      if (!match) {
        return fail(
          current,
          index,
          "INVALID_TARGET_STATE",
          `Entry ${index} target_state=${requestedTarget} is not one of the allowed destinations (${candidates.map((c) => c.to).join(", ")}) from ${current}.`,
        );
      }
      target = match.to;
    }

    if (entry.type === "BLOCKED" || entry.type === "DEFERRED") {
      if (suspendedFrom === null) {
        suspendedFrom = current;
      }
      // else: already suspended (e.g. BLOCKED -> DEFERRED chain) — keep
      // the originally interrupted state so a later RESUMED returns there.
    }

    current = target;
  }

  return { status: current, valid: true, errors: [] };
}

function fail(
  status: State,
  index: number,
  code: TransitionErrorCode,
  message: string,
): DeriveResult {
  return { status, valid: false, errors: [{ index, code, message }] };
}
