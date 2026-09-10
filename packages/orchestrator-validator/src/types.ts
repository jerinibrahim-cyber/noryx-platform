/**
 * Shared types for the NOAH orchestration task-record schema (Stage 1B).
 *
 * These types mirror docs/orchestrator/proposals/1B-implementation-plan.md
 * §3 (front matter) and §4 (history entries) exactly, plus a small number
 * of implementation-necessary completions of gaps left open by that
 * document — each one flagged in a comment here and described in
 * docs/orchestrator/SCHEMA.md's "Implementation notes" section.
 */

export const ACTORS = ["NOAH", "CLAUDE", "ANTIGRAVITY", "HUMAN"] as const;
export type Actor = (typeof ACTORS)[number];

/** owner_role uses the same closed set of role strings as actor. */
export type OwnerRole = Actor;

export const DECISION_TYPES = [
  "PROPOSAL_REVIEW",
  "IMPLEMENTATION_AUTHORIZATION",
  "VERIFICATION_RESULT",
  "CODE_REVIEW_RESULT",
  "CTO_FINAL_APPROVAL",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** Allowed `decision` values per decision type (§4 table). */
export const DECISION_VALUES: Readonly<
  Record<DecisionType, readonly string[]>
> = {
  PROPOSAL_REVIEW: ["APPROVED", "CHANGES_REQUIRED", "REJECTED"],
  IMPLEMENTATION_AUTHORIZATION: ["AUTHORIZED", "WITHHELD"],
  VERIFICATION_RESULT: ["PASSED", "FAILED"],
  CODE_REVIEW_RESULT: ["APPROVED", "CHANGES_REQUESTED"],
  CTO_FINAL_APPROVAL: ["APPROVED", "REJECTED"],
};

/**
 * Plain (non-decision) lifecycle entry types.
 *
 * GAP FILL: the approved plan's §4 example comment
 * (`type: DISCOVERY_STARTED # | PROPOSAL_SUBMITTED | BLOCKED | DEFERRED | RESUMED | CANCELLED`)
 * names a plain entry type for `DEFINED -> DISCOVERY` but the §5.2
 * transition table also requires two more "plain entry" transitions
 * (`AUTHORIZED -> IN_PROGRESS`, `IN_PROGRESS -> VERIFICATION`) without
 * naming their entry types. `IMPLEMENTATION_STARTED` and
 * `VERIFICATION_STARTED` are added here, following the same naming
 * pattern as `DISCOVERY_STARTED`, to make the already-approved transition
 * table mechanically representable. See docs/orchestrator/SCHEMA.md.
 */
export const PLAIN_ENTRY_TYPES = [
  "DISCOVERY_STARTED",
  "IMPLEMENTATION_STARTED",
  "VERIFICATION_STARTED",
  "PROPOSAL_SUBMITTED",
  "BLOCKED",
  "DEFERRED",
  "RESUMED",
  "CANCELLED",
] as const;
export type PlainEntryType = (typeof PLAIN_ENTRY_TYPES)[number];

export type HistoryEntryType = PlainEntryType | DecisionType;

export function isDecisionType(type: string): type is DecisionType {
  return (DECISION_TYPES as readonly string[]).includes(type);
}

export const STATES = [
  "DEFINED",
  "DISCOVERY",
  "PROPOSED",
  "APPROVED",
  "AUTHORIZED",
  "IN_PROGRESS",
  "VERIFICATION",
  "CODE_REVIEW",
  "FINAL_REVIEW",
  "DONE",
  "FAILED",
  "BLOCKED",
  "DEFERRED",
  "CANCELLED",
] as const; // length 14 — asserted by a test, not just stated in a comment
export type State = (typeof STATES)[number];

export function isState(value: unknown): value is State {
  return (
    typeof value === "string" && (STATES as readonly string[]).includes(value)
  );
}

export interface ArtifactRef {
  path: string | null;
  commit_sha: string | null;
  revision?: number;
  pr_url?: string | null;
  ci_run_ref?: string | null;
  checks?: string[];
  /** Required whenever commit_sha is null — never a silent omission. */
  note?: string;
}

export interface PlainHistoryEntryBase {
  type: PlainEntryType;
  actor: Actor;
  timestamp: string;
  reason?: string;
  resumed_to?: State | null;
  artifact_ref?: ArtifactRef;
  /** Carried on PROPOSAL_SUBMITTED entries — see §3's `revision` semantics. */
  revision?: number;
}

export interface DecisionHistoryEntry {
  type: DecisionType;
  actor: Actor;
  decision: string;
  /** required on PROPOSAL_REVIEW entries */
  reviewed_revision?: number;
  artifact_ref: ArtifactRef;
  scope: string;
  timestamp: string;
  supersedes?: number | null;
  /**
   * GAP FILL: disambiguates a decision entry whose (from-state, type,
   * decision) combination has more than one allowed destination in the
   * canonical TRANSITIONS table — currently `VERIFICATION_RESULT: PASSED`
   * from `VERIFICATION` (-> CODE_REVIEW or FINAL_REVIEW, "review warranted"
   * in the approved plan's prose) and `CODE_REVIEW_RESULT: CHANGES_REQUESTED`
   * from `CODE_REVIEW` (-> CODE_REVIEW, a retry loop, or -> FAILED,
   * "unsalvageable" in the approved plan's prose). The approved plan
   * describes these branches only in prose, without a structured field to
   * make the choice deterministic; `target_state` is that field. It is
   * validated against the single TRANSITIONS table (never a second,
   * independent branching rule) — see state-machine.ts `deriveStatus`.
   * Required only when the transition is genuinely ambiguous; ignored
   * (but if present, must match) otherwise.
   */
  target_state?: State;
}

export type HistoryEntry = PlainHistoryEntryBase | DecisionHistoryEntry;

export function isDecisionEntry(
  entry: HistoryEntry,
): entry is DecisionHistoryEntry {
  return isDecisionType(entry.type);
}

export function isPlainEntry(
  entry: HistoryEntry,
): entry is PlainHistoryEntryBase {
  return !isDecisionType(entry.type);
}

export interface TaskRecordFrontMatter {
  schema_version: number;
  task_id: string;
  title: string;
  stage: string;
  owner_role: OwnerRole;
  status: State;
  revision: number;
  retry_of?: string | null;
  resumes_cancelled?: string | null;
  history: HistoryEntry[];
}

/** Fields that must never change on an already-existing task record file. */
export const IMMUTABLE_FIELDS = ["task_id", "stage", "schema_version"] as const;
