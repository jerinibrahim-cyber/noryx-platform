// Root config — needed because ESLint's flat-config resolution starts
// from the process's cwd, not from each linted file's own directory. Every
// package also ships its own eslint.config.cjs (identical, just wiring in
// @noryx/eslint-config) so `pnpm --filter <pkg> run lint` — which runs with
// cwd = that package — resolves without walking up to this file. This root
// config exists for tools that invoke eslint from the repo root instead,
// e.g. lint-staged on a git commit.
module.exports = require("./packages/eslint-config/index.js");
