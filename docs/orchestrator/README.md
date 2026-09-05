# NOAH orchestration — task records (Stage 1B)

This directory is the Git-native orchestration control plane for NOAH's
task lifecycle: Markdown files with strict YAML front matter and a
structured, append-only `history` array, validated deterministically by
[`packages/orchestrator-validator`](../../packages/orchestrator-validator).

No new service, database, or runtime is introduced by this directory —
see `docs/orchestrator/proposals/1B-implementation-plan.md`'s "Locked
boundaries" for the full list of what this deliberately is not (n8n as a
control plane, RAG, autonomous agent loops, automatic task selection,
automatic merges).

## Layout

- `proposals/` — approved technical-proposal artifacts, cited by SHA from
  `docs/project/DECISIONS.md`.
- `tasks/` — individual task-record files, one per task, named
  `<task_id>.md`.
- `SCHEMA.md` — the front-matter and history shapes task records must
  follow.

## Where the rules actually live

The canonical state machine — every allowed transition, every decision
gate, and which states are terminal — is **not** documented as prose
here. It lives in exactly one place in code:
[`packages/orchestrator-validator/src/state-machine.ts`](../../packages/orchestrator-validator/src/state-machine.ts)
(`STATES`, `TRANSITIONS`, the derived `TERMINAL_STATES`, `isTerminal()`,
and `deriveStatus()`). `SCHEMA.md` describes the front-matter/history
_shapes_ and points here rather than reprinting the table, so there is
exactly one place it can ever be edited.

## Validating a task record

`packages/orchestrator-validator` exposes `validateTaskRecordChange()`
for validating one task-record file's change between a PR's merge-base
and HEAD (schema shape, append-only history, terminal freeze, task-ID/
artifact-SHA rules, `retry_of`/`resumes_cancelled` rules). Wiring this
into CI to gate real task-record PRs is deliberately a separate, later,
independently-reviewed change — see
`docs/orchestrator/proposals/1B-implementation-plan.md` §8. This stage
ships the library only.
