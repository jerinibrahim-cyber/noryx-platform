/**
 * Top-level orchestration of every §6 check for a single task-record
 * file's change between a PR's merge-base (BASE) and HEAD. This is the
 * one entry point a future CI step (§8 — deliberately not wired in this
 * stage) would call per changed file; this stage builds the library only.
 *
 * Input/output behavior matches §6 exactly: output is a structured report
 * naming exactly which check failed and why, and malformed input always
 * fails closed (never silently skipped).
 */
import { parseTaskRecordFile } from "./parse";
import { validateFrontMatterSchema } from "./schema";
import {
  validateAppendOnlyHistory,
  validateArtifactShas,
  validateImmutableFields,
  validateNewEntryOrdering,
  validateRetryAndResume,
  validateTerminalFreeze,
  lintForSecrets,
  ValidationIssue,
} from "./history-validation";
import { deriveStatus } from "./state-machine";
import { State, TaskRecordFrontMatter } from "./types";

export interface ValidateTaskRecordChangeInput {
  /** Repo-relative path, used only for reporting. */
  path: string;
  /** File content at the PR's merge-base, or undefined for a new file. */
  baseContent: string | undefined;
  /** File content at HEAD. */
  headContent: string;
  /** Resolves whether a commit SHA is an ancestor of (or equal to) the PR base. */
  isAncestorOrEqual: (sha: string) => Promise<boolean> | boolean;
  /** Resolves another task record by task_id (for retry_of / resumes_cancelled). */
  resolveReferencedTask: (
    taskId: string,
  ) =>
    | Promise<TaskRecordFrontMatter | undefined>
    | TaskRecordFrontMatter
    | undefined;
}

export interface ValidationReport {
  path: string;
  valid: boolean;
  status?: State;
  issues: ValidationIssue[];
}

export async function validateTaskRecordChange(
  input: ValidateTaskRecordChangeInput,
): Promise<ValidationReport> {
  const headParsed = parseTaskRecordFile(input.headContent);
  if (!headParsed.ok) {
    return fail(input.path, [
      { code: "MALFORMED_FILE", message: `HEAD: ${headParsed.error}` },
    ]);
  }
  const headSchema = validateFrontMatterSchema(headParsed.value.frontMatter);
  if (!headSchema.valid) {
    return fail(input.path, headSchema.issues);
  }
  const head = headSchema.value as TaskRecordFrontMatter;

  let base: TaskRecordFrontMatter | undefined;
  if (input.baseContent !== undefined) {
    const baseParsed = parseTaskRecordFile(input.baseContent);
    if (!baseParsed.ok) {
      return fail(input.path, [
        { code: "MALFORMED_FILE", message: `BASE: ${baseParsed.error}` },
      ]);
    }
    const baseSchema = validateFrontMatterSchema(baseParsed.value.frontMatter);
    if (!baseSchema.valid) {
      return fail(
        input.path,
        baseSchema.issues.map((i) => ({
          code: i.code,
          message: `BASE: ${i.message}`,
        })),
      );
    }
    base = baseSchema.value as TaskRecordFrontMatter;
  }

  const issues: ValidationIssue[] = [];
  issues.push(...validateImmutableFields(base, head));
  issues.push(...validateAppendOnlyHistory(base?.history, head.history));
  issues.push(...validateNewEntryOrdering(base?.history, head.history));
  issues.push(...validateTerminalFreeze(base, head));

  const newEntries = head.history.slice(base?.history.length ?? 0);
  issues.push(...lintForSecrets(newEntries));
  issues.push(
    ...(await validateArtifactShas(newEntries, input.isAncestorOrEqual)),
  );
  issues.push(
    ...(await validateRetryAndResume(head, base, input.resolveReferencedTask)),
  );

  const derived = deriveStatus(head.history);
  if (!derived.valid) {
    issues.push(
      ...derived.errors.map((e) => ({ code: e.code, message: e.message })),
    );
  } else if (derived.status !== head.status) {
    issues.push({
      code: "STATUS_MISMATCH",
      message: `Front matter "status: ${head.status}" does not match the status derived by replaying history ("${derived.status}"); status is never independently authoritative.`,
    });
  }

  return {
    path: input.path,
    valid: issues.length === 0,
    status: derived.valid ? derived.status : undefined,
    issues,
  };
}

function fail(path: string, issues: ValidationIssue[]): ValidationReport {
  return { path, valid: false, issues };
}
