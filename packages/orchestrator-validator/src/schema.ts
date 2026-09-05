/**
 * §6 item 1 — strict front-matter schema validation (unknown keys
 * rejected, not ignored; required fields/types/enums per §3/§4).
 *
 * Uses `class-validator` + `class-transformer` (already present elsewhere
 * in the repo — services/identity, services/sphere-finance) for the
 * front-matter object's scalar shape, per the approved plan's explicit
 * choice to reuse them instead of introducing a third-party schema
 * library. The `history` array's per-entry discriminated-union shape
 * (plain vs. decision entries) is validated by plain, directly-testable
 * functions in this same file, since a decorator-only encoding of a
 * discriminated union adds indirection without adding safety here.
 */
import { plainToInstance, Transform } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsString,
  IsOptional,
  Min,
  Matches,
  validateSync,
} from "class-validator";
import {
  ACTORS,
  Actor,
  ArtifactRef,
  DECISION_VALUES,
  PLAIN_ENTRY_TYPES,
  STATES,
  TaskRecordFrontMatter,
  isDecisionType,
  isState,
} from "./types";
import { ValidationIssue } from "./history-validation";

// The stage segment follows the repository's existing stage-label
// convention ("1A", "1B", ...), which is not all-lowercase, so only the
// slug and suffix segments are constrained to lowercase. Kept in sync
// with task-id.ts's TASK_ID_PATTERN.
const TASK_ID_PATTERN = /^[A-Za-z0-9]+-[a-z0-9-]+-[0-9a-f]{4}$/;

class TaskRecordFrontMatterDto {
  @IsInt()
  @Min(1)
  schema_version!: number;

  @IsString()
  @Matches(TASK_ID_PATTERN, {
    message: "task_id must match <stage>-<slug>-<4-hex-char-suffix>",
  })
  task_id!: string;

  @IsString()
  title!: string;

  @IsString()
  stage!: string;

  @IsIn(ACTORS)
  owner_role!: Actor;

  @IsIn(STATES)
  status!: string;

  @IsInt()
  @Min(0)
  revision!: number;

  @IsOptional()
  @Transform(({ value }) => value ?? null)
  retry_of!: string | null;

  @IsOptional()
  @Transform(({ value }) => value ?? null)
  resumes_cancelled!: string | null;

  // Validated separately by validateHistoryEntries — kept loosely typed
  // here so class-validator doesn't reject the array itself.
  history!: unknown[];
}

const ALLOWED_TOP_LEVEL_KEYS = new Set<string>([
  "schema_version",
  "task_id",
  "title",
  "stage",
  "owner_role",
  "status",
  "revision",
  "retry_of",
  "resumes_cancelled",
  "history",
]);

const REQUIRED_TOP_LEVEL_KEYS = [
  "schema_version",
  "task_id",
  "title",
  "stage",
  "owner_role",
  "status",
  "revision",
  "history",
] as const;

export interface FrontMatterValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  value?: TaskRecordFrontMatter;
}

export function validateFrontMatterSchema(
  raw: unknown,
): FrontMatterValidationResult {
  const issues: ValidationIssue[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      issues: [
        {
          code: "NOT_AN_OBJECT",
          message: "Front matter must be a YAML mapping (object).",
        },
      ],
    };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      issues.push({
        code: "UNKNOWN_FIELD",
        message: `Unknown top-level field "${key}" is not permitted.`,
      });
    }
  }
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in obj)) {
      issues.push({
        code: "MISSING_FIELD",
        message: `Required field "${key}" is missing.`,
      });
    }
  }
  if (issues.length > 0) return { valid: false, issues };

  const instance = plainToInstance(TaskRecordFrontMatterDto, obj, {
    excludeExtraneousValues: false,
  });
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: false,
    forbidUnknownValues: true,
  });
  for (const err of errors) {
    for (const constraint of Object.values(err.constraints ?? {})) {
      issues.push({
        code: "SCHEMA_VIOLATION",
        message: `Field "${err.property}": ${constraint}`,
      });
    }
  }

  if (!Array.isArray(obj.history)) {
    issues.push({
      code: "HISTORY_NOT_ARRAY",
      message: '"history" must be an array.',
    });
  } else {
    issues.push(...validateHistoryEntries(obj.history));
  }

  if (issues.length > 0) return { valid: false, issues };

  return {
    valid: true,
    issues: [],
    value: obj as unknown as TaskRecordFrontMatter,
  };
}

const ALLOWED_PLAIN_ENTRY_KEYS = new Set([
  "type",
  "actor",
  "timestamp",
  "reason",
  "resumed_to",
  "artifact_ref",
  "revision",
]);
const ALLOWED_DECISION_ENTRY_KEYS = new Set([
  "type",
  "actor",
  "decision",
  "reviewed_revision",
  "artifact_ref",
  "scope",
  "timestamp",
  "supersedes",
  "target_state",
]);
const ALLOWED_ARTIFACT_REF_KEYS = new Set([
  "path",
  "commit_sha",
  "revision",
  "pr_url",
  "ci_run_ref",
  "checks",
  "note",
]);

const GENERIC_SCOPE_VALUES = new Set(["", "all", "everything", "task"]);

function validateArtifactRef(
  ref: unknown,
  entryIndex: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    issues.push({
      code: "ARTIFACT_REF_INVALID",
      message: `Entry ${entryIndex}: artifact_ref must be an object.`,
    });
    return issues;
  }
  const obj = ref as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_ARTIFACT_REF_KEYS.has(key)) {
      issues.push({
        code: "UNKNOWN_FIELD",
        message: `Entry ${entryIndex}: unknown artifact_ref field "${key}".`,
      });
    }
  }
  if (!("path" in obj) || !("commit_sha" in obj)) {
    issues.push({
      code: "ARTIFACT_REF_MISSING_FIELD",
      message: `Entry ${entryIndex}: artifact_ref requires "path" and "commit_sha" (nullable).`,
    });
  }
  const commitSha = obj.commit_sha as ArtifactRef["commit_sha"];
  if ((commitSha === null || commitSha === undefined) && !obj.note) {
    issues.push({
      code: "ARTIFACT_REF_MISSING_NOTE",
      message: `Entry ${entryIndex}: artifact_ref.commit_sha is null but no "note" is present; never a silent omission.`,
    });
  }
  return issues;
}

export function validateHistoryEntries(history: unknown[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  history.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({
        code: "HISTORY_ENTRY_INVALID",
        message: `Entry ${i} must be an object.`,
      });
      return;
    }
    const entry = raw as Record<string, unknown>;
    const type = entry.type;

    if (typeof type !== "string") {
      issues.push({
        code: "HISTORY_ENTRY_MISSING_TYPE",
        message: `Entry ${i} is missing a string "type".`,
      });
      return;
    }

    const isPlain = (PLAIN_ENTRY_TYPES as readonly string[]).includes(type);
    const isDecision = isDecisionType(type);
    if (!isPlain && !isDecision) {
      issues.push({
        code: "UNRECOGNIZED_ENUM_VALUE",
        message: `Entry ${i} has unrecognized history entry type "${type}".`,
      });
      return;
    }

    if (
      typeof entry.actor !== "string" ||
      !(ACTORS as readonly string[]).includes(entry.actor)
    ) {
      issues.push({
        code: "INVALID_ACTOR",
        message: `Entry ${i} has invalid or missing actor "${String(entry.actor)}".`,
      });
    }
    if (typeof entry.timestamp !== "string" || !isIso8601(entry.timestamp)) {
      issues.push({
        code: "INVALID_TIMESTAMP",
        message: `Entry ${i} has invalid or missing ISO-8601 UTC timestamp.`,
      });
    }

    if (isPlain) {
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_PLAIN_ENTRY_KEYS.has(key)) {
          issues.push({
            code: "UNKNOWN_FIELD",
            message: `Entry ${i}: unknown field "${key}" for a plain entry.`,
          });
        }
      }
      if (
        (type === "BLOCKED" || type === "DEFERRED" || type === "CANCELLED") &&
        !entry.reason
      ) {
        issues.push({
          code: "MISSING_REASON",
          message: `Entry ${i} (${type}) requires a non-empty "reason".`,
        });
      }
      if (type === "RESUMED") {
        if (!entry.resumed_to || !isState(entry.resumed_to)) {
          issues.push({
            code: "MISSING_RESUMED_TO",
            message: `Entry ${i} (RESUMED) requires a valid "resumed_to" state.`,
          });
        }
      }
      if (type === "PROPOSAL_SUBMITTED") {
        if (!entry.artifact_ref) {
          issues.push({
            code: "MISSING_ARTIFACT_REF",
            message: `Entry ${i} (PROPOSAL_SUBMITTED) requires "artifact_ref".`,
          });
        } else {
          issues.push(...validateArtifactRef(entry.artifact_ref, i));
        }
      }
    }

    if (isDecision) {
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_DECISION_ENTRY_KEYS.has(key)) {
          issues.push({
            code: "UNKNOWN_FIELD",
            message: `Entry ${i}: unknown field "${key}" for a decision entry.`,
          });
        }
      }
      const allowedValues =
        DECISION_VALUES[type as keyof typeof DECISION_VALUES];
      if (
        typeof entry.decision !== "string" ||
        !allowedValues.includes(entry.decision)
      ) {
        issues.push({
          code: "UNRECOGNIZED_ENUM_VALUE",
          message: `Entry ${i} (${type}) has invalid decision "${String(entry.decision)}"; allowed: ${allowedValues.join(", ")}.`,
        });
      }
      if (
        type === "PROPOSAL_REVIEW" &&
        typeof entry.reviewed_revision !== "number"
      ) {
        issues.push({
          code: "MISSING_REVIEWED_REVISION",
          message: `Entry ${i} (PROPOSAL_REVIEW) requires "reviewed_revision".`,
        });
      }
      if (!entry.artifact_ref) {
        issues.push({
          code: "MISSING_ARTIFACT_REF",
          message: `Entry ${i} (${type}) requires "artifact_ref".`,
        });
      } else {
        issues.push(...validateArtifactRef(entry.artifact_ref, i));
      }
      const scope = entry.scope;
      if (
        typeof scope !== "string" ||
        GENERIC_SCOPE_VALUES.has(scope.trim().toLowerCase())
      ) {
        issues.push({
          code: "INVALID_SCOPE",
          message: `Entry ${i} (${type}) requires a non-empty, specific "scope" (not a generic value like "all"/"everything"/"task").`,
        });
      }
      if (entry.target_state !== undefined && !isState(entry.target_state)) {
        issues.push({
          code: "INVALID_TARGET_STATE",
          message: `Entry ${i} target_state "${String(entry.target_state)}" is not a valid state.`,
        });
      }
      if (
        entry.supersedes !== undefined &&
        entry.supersedes !== null &&
        typeof entry.supersedes !== "number"
      ) {
        issues.push({
          code: "INVALID_SUPERSEDES",
          message: `Entry ${i} supersedes must be null or an index (number).`,
        });
      }
    }
  });

  return issues;
}

function isIso8601(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value))
    return false;
  const t = Date.parse(value);
  return !Number.isNaN(t);
}

export { TaskRecordFrontMatterDto };
