'use strict';

/**
 * Dependency-free syntax lint for the checked-in TypeScript and JavaScript.
 *
 * This is intentionally narrower than a style linter: the repository has no
 * lint toolchain today, and adding one would turn Phase 0 into a dependency
 * migration. The gate still parses every source file with the same TypeScript
 * parser used by the build, so malformed TS/TSX/JS cannot be reported green.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const INCLUDE_ROOTS = ['src', 'tools/perf'];
const EXTENSIONS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
]);

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const files = INCLUDE_ROOTS.flatMap((relative) => filesUnder(path.join(ROOT, relative)));
const failures = [];

for (const filename of files) {
  const source = fs.readFileSync(filename, 'utf8');
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    EXTENSIONS.get(path.extname(filename))
  );
  for (const diagnostic of parsed.parseDiagnostics ?? []) {
    const position = diagnostic.start == null
      ? ''
      : `:${parsed.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
    failures.push(`${path.relative(ROOT, filename)}${position}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }
}

if (failures.length > 0) {
  console.error(`Syntax lint failed for ${failures.length} diagnostic(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Syntax lint passed for ${files.length} source files.`);
}
