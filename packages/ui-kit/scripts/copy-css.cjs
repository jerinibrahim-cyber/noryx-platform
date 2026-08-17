// Copies every .css file from src/ into the matching path under dist/.
// tsc only emits .ts/.tsx -> .js/.d.ts; CSS Modules imported by compiled
// components (and tokens.css) need to be copied alongside them so
// consumers' bundlers can resolve the relative `./Foo.module.css` imports
// that appear in dist/components/Foo.js.
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const DIST_DIR = path.join(__dirname, "..", "dist");

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      const relative = path.relative(SRC_DIR, fullPath);
      const destination = path.join(DIST_DIR, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(fullPath, destination);
    }
  }
}

walk(SRC_DIR);
