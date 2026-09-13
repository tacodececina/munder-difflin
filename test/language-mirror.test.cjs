'use strict';

/**
 * The language MIRROR must not conjure a config.json.
 *
 * The renderer owns the UI language (localStorage) and mirrors it into the
 * harness config so the MAIN process — which writes the brewed office dialogue —
 * knows what language the app is speaking. The mirror runs once per launch to
 * reconcile installs that picked a language before the config field existed.
 *
 * The reconcile compared the persisted value against the current language by
 * raw equality, and `undefined !== 'en'`. So on EVERY install that had never
 * touched the field — including a brand-new one still sitting in onboarding —
 * the first boot fired `updateConfig({ language: 'en' })`. `writeConfig`
 * persists the whole DEFAULTS-merged config, so that wrote a config.json before
 * onboarding had written one, which `readConfig` explicitly promises not to do
 * ("a bare read must not conjure a config.json before onboarding has written
 * one"), and broadcast a `config:changed` to every open floor for a no-op.
 *
 * The contract is in the field's own doc comment (src/main/config.ts): "Unset =
 * never changed from the default, i.e. English". Absent and 'en' are the SAME
 * value, and the mirror must treat them that way.
 *
 * These run the real module: src/renderer/src/i18n/index.ts is pixi/React-free
 * enough to load under plain node with a window + localStorage stand-in, so the
 * writes asserted below are the writes the app actually makes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

/** Every patch handed to `updateConfig`, in order. */
const writes = [];
/** The config as main would hand it back — starts EMPTY, i.e. a fresh install
 *  that has never saved a setting and has no `language` field at all. */
let config = {};

const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }
  },
  addEventListener: () => {},
  cth: {
    getConfig: async () => ({ ...config }),
    updateConfig: async (patch) => {
      writes.push(patch);
      config = { ...config, ...patch };
      return { ...config };
    }
  }
};

// Loading the module RUNS the once-per-launch reconcile — that is the behaviour
// under test, so it must happen after the stub above is in place.
const loadTs = require('./load-ts.cjs');
const { setLanguage } = loadTs('src/renderer/src/i18n/index.ts');

/** Let the mirror's promise chain settle (getConfig → updateConfig). */
const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

test('a fresh install is not written to on boot — absent already MEANS English', async () => {
  await settle();
  assert.deepEqual(writes, [], 'the launch reconcile must be silent when the two already agree');
  assert.deepEqual(config, {}, 'no config.json may be conjured before onboarding writes one');
});

test('picking a different language mirrors it exactly once', async () => {
  setLanguage('es');
  await settle();
  assert.deepEqual(writes, [{ language: 'es' }]);
});

test('re-picking the language already stored writes nothing', async () => {
  setLanguage('es');
  await settle();
  assert.equal(writes.length, 1, 'a no-op save still broadcasts config:changed to every floor');
});

test('switching BACK to English is a real change once something else was stored', async () => {
  setLanguage('en');
  await settle();
  assert.deepEqual(writes, [{ language: 'es' }, { language: 'en' }],
    'leaving es on disk would keep main brewing Spanish dialogue for an English UI');
});

test('the mirror survives a main process that cannot answer', async () => {
  const cth = window.cth;
  window.cth = { getConfig: async () => { throw new Error('ipc down'); }, updateConfig: cth.updateConfig };
  setLanguage('ar');
  await settle();
  window.cth = cth;
  assert.equal(writes.length, 2, 'a failed mirror costs flavour, never the language switch itself');
});
