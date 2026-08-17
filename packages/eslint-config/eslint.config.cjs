// This package's own config, self-applied — so tooling that walks up from
// packages/eslint-config/index.js (lint-staged, editors) finds a config
// too, without needing a workspace dependency edge onto itself.
module.exports = require("./index.js");
