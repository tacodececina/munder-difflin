'use strict';

// Audit artifact only. No product code and no additional dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'audit-results', 'phase6-coverage');
fs.mkdirSync(OUTPUT, { recursive: true });
const PREFIX = '(function (module, exports, require, __filename, __dirname) {\n';
const MODULES = [
  'src/renderer/src/scene/office/stationDirector.ts',
  'src/renderer/src/scene/office/stationActivity.ts',
  'src/renderer/src/scene/office/stationConnections.ts',
  'src/renderer/src/scene/office/movementDirector.ts',
  'src/renderer/src/scene/office/tileReservations.ts',
  'src/renderer/src/scene/office/toolActivityChannel.ts',
  'src/shared/toolStation.ts',
  'src/shared/hookEvents.ts',
];
const TESTS = [
  'test/station-director.test.cjs', 'test/station-activity.test.cjs',
  'test/station-connections.test.cjs', 'test/office-movement.test.cjs',
  'test/office-character-movement.test.cjs', 'test/office-station-themes.test.cjs',
  'test/hook-event-contract.test.cjs',
  'test/tool-station.test.cjs',
  ...process.argv.slice(2),
];
const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = filename => path.resolve(filename).replaceAll('\\', '/').toLowerCase();

function transpile(filename, source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      strict: true, esModuleInterop: true, inlineSourceMap: true, inlineSources: true,
    }, fileName: filename, reportDiagnostics: true,
  }).outputText;
}

// V8 ranges use UTF-16 offsets into the actual vm.Script source. A nested
// function or branch overrides a surrounding positive module/function range.
function countAt(ranges, offset) {
  let length = Infinity, result = 0;
  for (const range of ranges) {
    if (range.startOffset <= offset && offset < range.endOffset) {
      const span = range.endOffset - range.startOffset;
      if (span < length) { length = span; result = range.count; }
      else if (span === length) result = Math.min(result, range.count);
    }
  }
  return result;
}

assert.equal(countAt([{ startOffset: 0, endOffset: 100, count: 1 },
  { startOffset: 10, endOffset: 30, count: 0 }, { startOffset: 15, endOffset: 20, count: 2 }], 17), 2);
assert.equal(countAt([{ startOffset: 0, endOffset: 100, count: 1 },
  { startOffset: 10, endOffset: 30, count: 0 }], 20), 0);
assert.equal(countAt([{ startOffset: 0, endOffset: 10, count: 1 }], 10), 0);

const loaderSource = fs.readFileSync(path.join(ROOT, 'test/load-ts.cjs'), 'utf8');
assert.ok(loaderSource.includes('inlineSourceMap: true') && loaderSource.includes('inlineSources: true'));
assert.ok(loaderSource.includes('`(function (module, exports, require, __filename, __dirname) {\\n${output.outputText}\\n})`'),
  'The audit must be updated when the load-ts wrapper changes');
function captureSource(relative) {
  const filename = path.resolve(ROOT, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const emitted = transpile(filename, source);
  const inline = emitted.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/);
  assert.ok(inline, `inline source map missing: ${relative}`);
  const map = JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8'));
  assert.equal(map.sourcesContent.length, 1);
  assert.equal(map.sourcesContent[0], source, 'source map must match the exact tested TS');
  return { relative, filename, source, emitted, map, sourceSha256: hash(source),
    script: `${PREFIX}${emitted}\n})`, samples: [] };
}
const snapshots = MODULES.map(captureSource);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDirectory = path.join(OUTPUT, `phase6-v8-${stamp}`);
fs.mkdirSync(rawDirectory, { recursive: true });
// Calibration exercises real V8 collection plus mapping across a template
// literal, an untaken branch, and a never-called function. It is NOT included
// in product coverage totals.
const calibrationPath = path.join(rawDirectory, 'mapping-calibration.ts');
const calibrationSource = [
  'export function chosen(flag: boolean): string {',
  '  const rendered = `${flag}`;',
  '  if (flag) {',
  '    return rendered;',
  '  }',
  "  return 'unused branch';",
  '}',
  'export function unused(): string {',
  "  return 'unused function';",
  '}',
  '',
].join('\n');
fs.writeFileSync(calibrationPath, calibrationSource, 'utf8');
const calibrationTest = path.join(rawDirectory, 'mapping-calibration.test.cjs');
fs.writeFileSync(calibrationTest, [
  "const assert = require('node:assert/strict');",
  `const { chosen } = require(${JSON.stringify(path.join(ROOT, 'test/load-ts.cjs'))})(${JSON.stringify(calibrationPath)});`,
  "assert.equal(chosen(true), 'true');",
].join('\n'), 'utf8');
TESTS.push(path.relative(ROOT, calibrationTest));
const calibrationSnapshot = captureSource(path.relative(ROOT, calibrationPath));
snapshots.push(calibrationSnapshot);
const child = spawnSync(process.execPath, ['--test', ...TESTS], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  env: { ...process.env, NODE_V8_COVERAGE: rawDirectory },
});
fs.writeFileSync(path.join(OUTPUT, 'phase6-source-coverage-tests.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`, 'utf8');
if (child.error) throw child.error;
assert.equal(child.status, 0, 'Focused tests must pass before coverage is accepted');
assert.equal(fs.readFileSync(path.join(ROOT, 'test/load-ts.cjs'), 'utf8'), loaderSource, 'Loader changed during collection');
for (const snapshot of snapshots) {
  assert.equal(hash(fs.readFileSync(snapshot.filename, 'utf8')), snapshot.sourceSha256,
    `${snapshot.relative} changed during collection; rerun against a stable snapshot`);
}

const byName = new Map(snapshots.map(snapshot => [normalize(snapshot.filename), snapshot]));
let rawFiles = 0;
for (const name of fs.readdirSync(rawDirectory)) {
  if (!name.endsWith('.json')) continue;
  rawFiles++;
  const coverage = JSON.parse(fs.readFileSync(path.join(rawDirectory, name), 'utf8'));
  for (const script of coverage.result ?? []) {
    let url = script.url;
    if (url.startsWith('file:')) url = fileURLToPath(url);
    if (!path.isAbsolute(url)) continue;
    const snapshot = byName.get(normalize(url));
    if (!snapshot) continue;
    const ranges = script.functions.flatMap(fn => fn.ranges);
    assert.equal(Math.max(...ranges.map(range => range.endOffset)), snapshot.script.length,
      `${snapshot.relative}: generated script length does not match V8; offset mapping is unsafe`);
    assert.ok(script.functions.every(fn => typeof fn.isBlockCoverage === 'boolean'));
    snapshot.samples.push(ranges);
  }
}

// Punctuation-only lines (braces/semicolon) and erased TS declarations must not
// inflate the denominator. Identifiers, literals, keywords, and operators are
// mapped token by token. Tokens with no original location are generated boilerplate.
const ignoredTokens = new Set([
  ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.DotToken,
  ts.SyntaxKind.ColonToken,
]);

function mappedCoverage(snapshot) {
  assert.ok(snapshot.samples.length, `No V8 sample for ${snapshot.relative}; cannot report coverage`);
  const trace = new TraceMap(snapshot.map);
  const generatedFile = ts.createSourceFile(snapshot.filename + '.js', snapshot.emitted, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const tokens = [];
  function collectTokens(node) {
    const children = node.getChildren(generatedFile);
    if (children.length) for (const child of children) collectTokens(child);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.getWidth(generatedFile) > 0) tokens.push(node);
  }
  collectTokens(generatedFile);
  const lines = new Map();
  let unmappedTokens = 0, mappedTokens = 0;
  for (const token of tokens) {
    if (ignoredTokens.has(token.kind)) continue;
    const emittedOffset = token.getStart(generatedFile);
    const position = generatedFile.getLineAndCharacterOfPosition(emittedOffset);
    const original = originalPositionFor(trace, { line: position.line + 1, column: position.character });
    if (original.line === null) { unmappedTokens++; continue; }
    assert.ok(original.line > 0 && original.line <= snapshot.source.split(/\r?\n/).length);
    const offset = PREFIX.length + emittedOffset;
    const executed = snapshot.samples.some(ranges => countAt(ranges, offset) > 0);
    const line = lines.get(original.line) ?? { tokens: 0, coveredTokens: 0 };
    line.tokens++; if (executed) line.coveredTokens++;
    lines.set(original.line, line); mappedTokens++;
  }
  const fullyCovered = [], partial = [], uncovered = [];
  for (const [line, info] of [...lines].sort((a, b) => a[0] - b[0])) {
    if (info.coveredTokens === info.tokens) fullyCovered.push(line);
    else if (info.coveredTokens > 0) partial.push(line);
    else uncovered.push(line);
  }
  const denominator = lines.size;
  return {
    file: snapshot.relative, sourceSha256: snapshot.sourceSha256,
    v8ScriptSamples: snapshot.samples.length, mappedTokens, unmappedGeneratedTokens: unmappedTokens,
    executableMappedLines: denominator,
    fullyCoveredLines: fullyCovered, partiallyCoveredLines: partial, uncoveredLines: uncovered,
    // A conservative metric: partially covered lines count as uncovered.
    strictLinePercent: Number((100 * fullyCovered.length / denominator).toFixed(2)),
    anyExecutionLinePercent: Number((100 * (fullyCovered.length + partial.length) / denominator).toFixed(2)),
    lineDetails: Object.fromEntries([...lines].sort((a, b) => a[0] - b[0])),
  };
}

const calibration = mappedCoverage(calibrationSnapshot);
assert.ok(calibration.fullyCoveredLines.includes(4), 'called branch must map to covered TS line 4');
assert.ok(calibration.uncoveredLines.includes(6), 'untaken branch after a template must map to uncovered TS line 6');
assert.ok(calibration.uncoveredLines.includes(9), 'never-called function must map to uncovered TS line 9');
const modules = snapshots.filter(snapshot => snapshot !== calibrationSnapshot).map(mappedCoverage);
const totalLines = modules.reduce((sum, row) => sum + row.executableMappedLines, 0);
const totalFullyCovered = modules.reduce((sum, row) => sum + row.fullyCoveredLines.length, 0);
const strictLinePercent = Number((100 * totalFullyCovered / totalLines).toFixed(2));
const report = {
  generatedAt: new Date().toISOString(), node: process.version, typescript: ts.version,
  loaderSha256: hash(loaderSource), command: [process.execPath, '--test', ...TESTS],
  rawDirectory, rawFiles, testExitCode: child.status,
  metric: 'Source-mapped TypeScript lines with meaningful emitted tokens; every mapped token on a line must execute in at least one test sample for that line to count as fully covered.',
  wrapper: { addedLines: 1, utf16PrefixLength: PREFIX.length, verifiedExactScriptLength: true },
  calibration: { passed: true, includedInProductTotals: false, result: calibration },
  total: { executableMappedLines: totalLines, fullyCoveredLines: totalFullyCovered, strictLinePercent,
    meets80: strictLinePercent >= 80, eachModuleMeets80: modules.every(row => row.strictLinePercent >= 80) },
  modules,
};
fs.writeFileSync(path.join(OUTPUT, 'phase6-source-coverage.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
const rows = modules.map(row => `| ${row.file} | ${row.fullyCoveredLines.length}/${row.executableMappedLines} | ${row.strictLinePercent}% | ${[...row.partiallyCoveredLines, ...row.uncoveredLines].sort((a,b)=>a-b).join(', ') || '-'} |`);
const methodology = `# Phase 6 source-mapped TypeScript coverage\n\nGenerated ${report.generatedAt}. Focused test exit: ${child.status}.\n\n| TypeScript module | Fully covered mapped lines | Conservative coverage | Partial/uncovered TS lines |\n|---|---:|---:|---|\n${rows.join('\n')}\n\nTotal: **${totalFullyCovered}/${totalLines} (${strictLinePercent}%)**. Every module >=80%: **${report.total.eachModuleMeets80}**.\n\n## Method\n\n- Collect native V8 block ranges with NODE_V8_COVERAGE in isolated Node test processes. Test log and raw range JSONs are retained beside this report.\n- Recreate exactly test/load-ts.cjs TypeScript transpilation (CommonJS, ES2022, strict, esModuleInterop, inlineSourceMap, inlineSources). Verify source contents embedded in each source map, source SHA-256 before/after the run, loader stability, and exact V8 script length.\n- The vm.Script has a one-line wrapper before emitted JavaScript. Add its ${PREFIX.length} UTF-16 code units to generated token offsets when reading V8 ranges; query the inline source map using unwrapped generated line/column. V8 and TypeScript offsets both count UTF-16 code units, not bytes.\n- Use @jridgewell/trace-mapping originalPositionFor for each meaningful generated token. The smallest enclosing V8 function/block range determines execution; a nested count=0 overrides an executed enclosing module. A token is covered if any collected test process executes it.\n- Group mapped tokens by original TypeScript line. The conservative reported percentage counts a line only if ALL its mapped tokens executed. Partial lines are explicitly listed and do not count toward the >=80% threshold. The machine-readable report also gives the less strict any-execution percentage.\n- Exclude whitespace/comments, punctuation-only generated lines, erased types/interfaces, and tokens with no source-map location. Generated helpers cannot inflate TypeScript totals. Raw emitted-JavaScript coverage percentages are not used.\n\n## Limits\n\nThis is a custom, source-mapped line metric, not Istanbul statement/branch coverage and not proof of exhaustive behavior. TypeScript's source map assigns original positions, not exact source spans; token locations inherit the nearest preceding mapping on the generated line. Inline multi-statement lines can be partially covered; the conservative rule intentionally penalizes them. Mapped declaration tokens count as executable only as represented by V8 ranges. Type-only lines have no runtime coverage meaning and are excluded. Functions used only through mocks remain subject to the actual executed implementation. The eight listed modules are the complete denominator; this report makes no coverage claim about OfficeFloor, hooks.ts, hive.ts, or the repository as a whole. A source change requires regeneration.\n\nReproduce from repo root:\n\n\`node docs/audits/phase6-source-coverage.cjs\`\n`;
const verifiedMethodology = methodology
  .replace('- Use @jridgewell/trace-mapping', '- Enumerate leaf tokens from the parsed generated JavaScript AST (not a bare lexical scanner), preserving template-literal interpolation and regular-expression context.\n- Use @jridgewell/trace-mapping')
  .replace('## Limits', '## Calibration\n\nThe same V8 run executes a separate TypeScript fixture containing a template literal, a taken branch, an untaken branch, and a never-called function. The report asserts that original TS line 4 is covered and original TS lines 6 and 9 are uncovered. The fixture and its V8 data are retained; its lines are excluded from product totals. Three additional synthetic range assertions verify innermost-range precedence and exclusive range ends. All checks passed.\n\n## Limits');
fs.writeFileSync(path.join(OUTPUT, 'phase6-source-coverage.md'), verifiedMethodology, 'utf8');
console.log(JSON.stringify({ total: report.total, modules: modules.map(({ file, strictLinePercent }) => ({ file, strictLinePercent })), rawFiles, report: 'audit-results/phase6-coverage/phase6-source-coverage.md' }, null, 2));
