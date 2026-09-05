/**
 * Stable task-ID generation per §3: `<stage>-<slug>-<suffix>`, `<suffix>`
 * a 4-character random hex string generated locally at creation — no
 * external ID service, no registry, no network call.
 */
import { randomBytes } from "node:crypto";

// The stage segment follows the repository's existing stage-label
// convention ("1A", "1B", ...), which is not all-lowercase, so only the
// slug and suffix segments are constrained to lowercase.
const TASK_ID_PATTERN = /^[A-Za-z0-9]+-[a-z0-9-]+-[0-9a-f]{4}$/;

export function generateTaskId(stage: string, slug: string): string {
  const normalizedSlug = slug.toLowerCase();
  const suffix = randomBytes(2).toString("hex");
  return `${stage}-${normalizedSlug}-${suffix}`;
}

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId);
}
