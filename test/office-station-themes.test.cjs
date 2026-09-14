'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

// Execute the real registry and loader, stubbing only Vite image imports and
// cast/localStorage boundaries. No renderer or image decoding is needed to
// prove that changing themes cannot borrow office station coordinates.
function loadThemeModule(name, overrides = {}) {
  const filename = path.resolve(__dirname, '../src/renderer/src/scene/office', `${name}.ts`);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  const requireModule = request => {
    if (Object.hasOwn(overrides, request)) return overrides[request];
    if (request.endsWith('?url')) return 'fixture-image-url';
    if (request.endsWith('?raw')) {
      return fs.readFileSync(path.resolve(__dirname, '../src/renderer/src', request.slice(2, -4)), 'utf8');
    }
    if (request === './cast') return { CAST_BY_NAME: {}, DEFAULT_CHARACTER: 'fixture', getCastFrames: async () => [] };
    if (request.startsWith('./')) return loadTs(`src/renderer/src/scene/office/${request.slice(2)}.ts`);
    if (request.startsWith('@/')) return loadTs(`src/renderer/src/${request.slice(2)}.ts`);
    throw new Error(`Unexpected dependency ${request}`);
  };
  new vm.Script(`(function(module,exports,require) {\n${output}\n})`, { filename }).runInThisContext()(mod, mod.exports, requireModule);
  return mod.exports;
}

const registry = loadThemeModule('themeRegistry');
const loader = loadThemeModule('themeLoader', {
  './themeRegistry': registry,
  './customThemes': { getCustomTheme: () => undefined, isCustomThemeId: id => id.startsWith('custom:') },
});

test('every non-office built-in theme has no station destinations', async () => {
  assert.equal(registry.OFFICE_THEME.stationSpots.length, 5);
  for (const id of ['friends', 'brooklyn99', 'siliconvalley', 'got', 'hogwarts', 'isometric']) {
    const theme = await loader.loadTheme(id);
    assert.equal(theme.id, id);
    assert.equal(theme.stationSpots, undefined, id);
  }
});

test('custom bundle loading preserves its authored stations and absent stations', () => {
  const fixture = path.join(__dirname, 'fixtures/theme-bundle-valid');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'theme.json'), 'utf8'));
  const map = fs.readFileSync(path.join(fixture, 'map.tmj'), 'utf8');
  const build = () => loader.buildThemeConfigFromBundle('custom:fixture', manifest, map, ['fixture-image-url']);
  assert.equal(build().stationSpots, undefined);
  manifest.stationSpots = [];
  assert.deepEqual(build().stationSpots, []);
  manifest.stationSpots = [{ kind: 'terminal', stand: { x: 1, y: 3 }, facing: 'right' }];
  assert.deepEqual(build().stationSpots, manifest.stationSpots);
  assert.notDeepEqual(build().stationSpots, registry.OFFICE_THEME.stationSpots);
});
