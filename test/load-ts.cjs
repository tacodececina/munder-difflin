'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const cache = new Map();

// The bundler's path aliases, as declared in tsconfig.web.json / electron.vite
// config. Without them a renderer module that imports a sibling through `@/`
// (the convention everywhere outside scene/office) is unloadable here, and the
// only way to test it would be to duplicate the code it imports.
const ALIASES = [
  ['@shared/', 'src/shared'],
  ['@/', 'src/renderer/src']
];

function resolveTs(fromDir, request) {
  const alias = ALIASES.find(([prefix]) => request.startsWith(prefix));
  const base = alias
    ? path.resolve(__dirname, '..', alias[1], request.slice(alias[0].length))
    : path.resolve(fromDir, request);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(filename) {
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  // A `.json` import is data, not TypeScript. The bundler parses it (the app
  // compiles with resolveJsonModule); handing it to transpileModule instead
  // fails output generation outright, so parse it the same way here.
  if (filename.endsWith('.json')) {
    const json = { exports: JSON.parse(fs.readFileSync(filename, 'utf8')) };
    cache.set(filename, json);
    return json.exports;
  }
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      // Match tsconfig.node/tsconfig.web. Without it a default import of a CJS
      // builtin (`import path from 'node:path'`) compiles to `path_1.default`,
      // which is undefined at run time — the module loads fine and then explodes
      // on first use. Test harness only; no shipped code compiles through here.
      esModuleInterop: true,
      inlineSourceMap: true,
      inlineSources: true
    },
    fileName: filename,
    reportDiagnostics: true
  });
  if (output.diagnostics?.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(output.diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n'
    }));
  }
  const mod = { exports: {} };
  cache.set(filename, mod);
  const localRequire = (request) => {
    if (request.startsWith('.') || ALIASES.some(([prefix]) => request.startsWith(prefix))) {
      const resolved = resolveTs(path.dirname(filename), request);
      if (resolved) return loadFile(resolved);
    }
    return require(request);
  };
  // Use a named V8 script instead of an anonymous Function. Node's native test
  // coverage otherwise attributes all transpiled execution to this loader and
  // can report a misleading 100% while the real TypeScript module is absent.
  // This names the emitted JavaScript, including the wrapper below. Native V8
  // line totals are NOT remapped TypeScript source coverage; consumers must not
  // claim that percentage covers the original TS lines or unlisted modules.
  const run = new vm.Script(
    `(function (module, exports, require, __filename, __dirname) {\n${output.outputText}\n})`,
    { filename }
  ).runInThisContext();
  run(mod, mod.exports, localRequire, filename, path.dirname(filename));
  return mod.exports;
}

/** Load a TypeScript module and its local TypeScript imports for node:test. */
module.exports = function loadTs(relativePath) {
  return loadFile(path.resolve(__dirname, '..', relativePath));
};
