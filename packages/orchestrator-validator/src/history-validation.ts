/**
 * File-level and history-level checks from §6 that are distinct from
 * `deriveStatus` (item 2): append-only history (item 3), new-entry
 * ordering (item 4), terminal freeze (item 5), task_id/stage/
 * schema_version immutability (item 6), artifact SHA validation (item 7),
 * and secret-pattern linting (item 8).
 */
import { deepStrictEqual } from "node:assert";
import { deriveStatus, isTerminal } from "./state-machine";
import {
  IMMUTABLE_FIELDS,
  TaskRecordFrontMatter,
  HistoryEntry,
  isDecisionEntry,
  isPlainEntry,
  ArtifactRef,
} from "./types";

export interface ValidationIssue {
  code: string;
  message: string;
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * §6 item 3 — append-only history validation.
 *
 * Given the file's content at the PR's merge-base (BASE, or undefined for
 * a new file) and at HEAD: `len(HEAD.history) >= len(BASE.history)` and
 * every index in [0, len(BASE.history)) is deep-equal between BASE and
 * HEAD. This single invariant is what rejects modification, deletion,
 * reordering, and backdating of any *existing* entry.
 */
export function validateAppendOnlyHistory(
  baseHistory: readonly HistoryEntry[] | undefined,
  headHistory: readonly HistoryEntry[],
): ValidationIssue[] {
  if (!baseHistory) return [];
  const issues: ValidationIssue[] = [];
  if (headHistory.length < baseHistory.length) {
    issues.push({
      code: "HISTORY_SHRUNK",
      message: `HEAD history has ${headHistory.length} entries, fewer than BASE's ${baseHistory.length}; history is append-only.`,
    });
    return issues;
  }
  for (let i = 0; i < baseHistory.length; i++) {
    if (!deepEqual(baseHistory[i], headHistory[i])) {
      issues.push({
        code: "HISTORY_ENTRY_MODIFIED",
        message: `History entry at index ${i} differs between BASE and HEAD; existing entries are append-only and immutable (covers edits, deletions, and reordering).`,
      });
    }
  }
  return issues;
}

/**
 * §6 item 4 — every newly appended entry's timestamp is strictly greater
 * than the one before it. `deriveStatus` already enforces this across the
 * whole array as part of replay; this standalone check exists so the
 * "new entries only" case can be reported independently of transition
 * validity, and so it is unit-testable in isolation per §7's coverage
 * plan ("Backdating").
 */
export function validateNewEntryOrdering(
  baseHistory: readonly HistoryEntry[] | undefined,
  headHistory: readonly HistoryEntry[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const startIndex = baseHistory?.length ?? 0;
  let prevTimestamp =
    startIndex > 0 ? (headHistory[startIndex - 1]?.timestamp ?? null) : null;
  for (let i = startIndex; i < headHistory.length; i++) {
    const entry = headHistory[i]!;
    if (prevTimestamp !== null && !(entry.timestamp > prevTimestamp)) {
      issues.push({
        code: "TIMESTAMP_NOT_INCREASING",
        message: `New entry at index ${i} has timestamp "${entry.timestamp}" which does not strictly increase over the preceding entry's "${prevTimestamp}".`,
      });
    }
    prevTimestamp = entry.timestamp;
  }
  return issues;
}

/**
 * §6 item 5 — terminal freeze. If BASE's derived status is terminal, any
 * diff to the file at all is rejected (fast-fail), backed by the same
 * derived terminal-state set used everywhere else (`isTerminal` /
 * `TERMINAL_STATES` in state-machine.ts).
 */
export function validateTerminalFreeze(
  base: TaskRecordFrontMatter | undefined,
  head: TaskRecordFrontMatter,
): ValidationIssue[] {
  if (!base) return [];
  const baseDerived = deriveStatus(base.history);
  if (!baseDerived.valid || !isTerminal(baseDerived.status)) return [];
  if (!deepEqual(base, head)) {
    return [
      {
        code: "TERMINAL_STATE_MUTATED",
        message: `BASE's derived status (${baseDerived.status}) is terminal; no diff to this file is accepted, not even a metadata-only addition.`,
      },
    ];
  }
  return [];
}

/**
 * §6 item 6 — task_id/stage/schema_version immutability. Any diff
 * changing these on a pre-existing file is rejected.
 */
export function validateImmutableFields(
  base: TaskRecordFrontMatter | undefined,
  head: TaskRecordFrontMatter,
): ValidationIssue[] {
  if (!base) return [];
  const issues: ValidationIssue[] = [];
  for (const field of IMMUTABLE_FIELDS) {
    if (base[field] !== head[field]) {
      issues.push({
        code: "IMMUTABLE_FIELD_CHANGED",
        message: `Field "${field}" changed from ${JSON.stringify(base[field])} to ${JSON.stringify(head[field])}; it is immutable once set.`,
      });
    }
  }
  return issues;
}

/**
 * §6 item 7 — artifact SHA validation. Any new decision entry's
 * `artifact_ref.commit_sha`, when non-null, must resolve to a commit that
 * is an ancestor of or equal to the PR's base commit. `isAncestorOrEqual`
 * is injected so this stays free of any direct Git dependency and is unit
 * testable with synthetic resolvers.
 */
export async function validateArtifactShas(
  newEntries: readonly HistoryEntry[],
  isAncestorOrEqual: (sha: string) => Promise<boolean> | boolean,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (let i = 0; i < newEntries.length; i++) {
    const entry = newEntries[i]!;
    const ref: ArtifactRef | undefined = entry.artifact_ref;
    if (!ref) continue;
    if (ref.commit_sha === null || ref.commit_sha === undefined) {
      if (!ref.note) {
        issues.push({
          code: "ARTIFACT_REF_MISSING_NOTE",
          message: `New entry references an artifact with commit_sha null but no "note" explaining why; never a silent omission.`,
        });
      }
      continue;
    }
    const ok = await isAncestorOrEqual(ref.commit_sha);
    if (!ok) {
      issues.push({
        code: "ARTIFACT_SHA_NOT_ANCESTOR",
        message: `artifact_ref.commit_sha "${ref.commit_sha}" does not resolve to a commit that is an ancestor of (or equal to) the PR's base commit.`,
      });
    }
  }
  return issues;
}

/**
 * §6 item 8 — secret-pattern lint. A narrow, deterministic regex check on
 * new history-entry text fields, as defense-in-depth alongside the
 * repository's existing gitleaks CI job. Deliberately conservative (a few
 * high-confidence patterns) — this is not a replacement for gitleaks.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN OPENSSH PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id shape
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token shapes
  /[A-Za-z0-9+/]{80,}={0,2}/, // long high-entropy base64-ish run
];

function textFieldsOf(entry: HistoryEntry): string[] {
  const fields: string[] = [];
  if (isPlainEntry(entry) && entry.reason) fields.push(entry.reason);
  if (isDecisionEntry(entry) && entry.scope) fields.push(entry.scope);
  if (entry.artifact_ref?.note) fields.push(entry.artifact_ref.note);
  return fields;
}

export function lintForSecrets(
  newEntries: readonly HistoryEntry[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  newEntries.forEach((entry, i) => {
    for (const text of textFieldsOf(entry)) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          issues.push({
            code: "POSSIBLE_SECRET",
            message: `New entry at index ${i} contains text matching a secret-like pattern (${pattern}); rejected as defense-in-depth alongside gitleaks.`,
          });
          break;
        }
      }
    }
  });
  return issues;
}

/**
 * `retry_of` / `resumes_cancelled` validation (§5.5, §7 "retry_of
 * behavior"). Requires looking up the referenced task's own derived
 * status, so a resolver is injected rather than assumed to be a sibling
 * in the same diff.
 */
export async function validateRetryAndResume(
  head: TaskRecordFrontMatter,
  base: TaskRecordFrontMatter | undefined,
  resolveReferencedTask: (
    taskId: string,
  ) =>
    | Promise<TaskRecordFrontMatter | undefined>
    | TaskRecordFrontMatter
    | undefined,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  if (base) {
    if ((base.retry_of ?? null) !== (head.retry_of ?? null)) {
      issues.push({
        code: "RETRY_OF_CHANGED",
        message: `"retry_of" changed from ${JSON.stringify(base.retry_of ?? null)} to ${JSON.stringify(head.retry_of ?? null)}; it may only be set once, at creation.`,
      });
    }
    if ((base.resumes_cancelled ?? null) !== (head.resumes_cancelled ?? null)) {
      issues.push({
        code: "RESUMES_CANCELLED_CHANGED",
        message: `"resumes_cancelled" changed from ${JSON.stringify(base.resumes_cancelled ?? null)} to ${JSON.stringify(head.resumes_cancelled ?? null)}; it may only be set once, at creation.`,
      });
    }
    return issues; // only checked at creation time (base === undefined) below
  }

  if (head.retry_of) {
    const referenced = await resolveReferencedTask(head.retry_of);
    if (!referenced) {
      issues.push({
        code: "RETRY_OF_TARGET_NOT_FOUND",
        message: `retry_of="${head.retry_of}" does not resolve to an existing task record.`,
      });
    } else {
      const derived = deriveStatus(referenced.history);
      if (!derived.valid || derived.status !== "FAILED") {
        issues.push({
          code: "RETRY_OF_TARGET_NOT_FAILED",
          message: `retry_of="${head.retry_of}" must reference a task whose derived status is FAILED (found ${derived.status}).`,
        });
      }
    }
  }

  if (head.resumes_cancelled) {
    const referenced = await resolveReferencedTask(head.resumes_cancelled);
    if (!referenced) {
      issues.push({
        code: "RESUMES_CANCELLED_TARGET_NOT_FOUND",
        message: `resumes_cancelled="${head.resumes_cancelled}" does not resolve to an existing task record.`,
      });
    } else {
      const derived = deriveStatus(referenced.history);
      if (!derived.valid || derived.status !== "CANCELLED") {
        issues.push({
          code: "RESUMES_CANCELLED_TARGET_NOT_CANCELLED",
          message: `resumes_cancelled="${head.resumes_cancelled}" must reference a task whose derived status is CANCELLED (found ${derived.status}).`,
        });
      }
    }
  }

  return issues;
}
