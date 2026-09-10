/**
 * Front-matter extraction for task-record Markdown files: `---` fenced
 * YAML front matter parsed with `js-yaml`'s strict `JSON_SCHEMA`, per the
 * approved plan's explicit choice (§1.6, §7) to disable YAML 1.1's
 * implicit-typing footguns (unquoted yes/no/on/off, native date coercion).
 */
import { load, JSON_SCHEMA } from "js-yaml";

const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedTaskRecordFile {
  frontMatter: unknown;
  body: string;
}

export type ParseFailure = { ok: false; error: string };
export type ParseSuccess = { ok: true; value: ParsedTaskRecordFile };

export function parseTaskRecordFile(
  content: string,
): ParseSuccess | ParseFailure {
  const match = FRONT_MATTER_PATTERN.exec(content);
  if (!match) {
    return {
      ok: false,
      error: "No YAML front matter block (--- ... ---) found.",
    };
  }
  // Capture groups 1 and 2 are guaranteed present whenever the pattern
  // matches at all (both are always-present, greedy/lazy groups, never
  // optional) — non-null here reflects that, not an unchecked assumption.
  const yamlText = match[1]!;
  const body = match[2]!;
  let frontMatter: unknown;
  try {
    frontMatter = load(yamlText, { schema: JSON_SCHEMA });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid YAML front matter: ${message}` };
  }
  return { ok: true, value: { frontMatter, body } };
}
