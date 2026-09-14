'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Render the actual component with controlled hook inputs and bridge boundaries.
function renderInspector(room = 'briefing', { enabled = true, visitor = false } = {}) {
  const calls = [];
  const events = new Map();
  const effects = [];
  const info = { source: 'hive:log', scope: 'routed-messages', availability: 'available', lastValidAt: 1000 };
  const detail = { target: { kind: 'room', room }, snapshot: {
    capturedAt: 2000, breaker: { info, readings: [] }, tasks: [], taskReading: info,
    ci: { info, repo: null, runs: null }, handoffs: { info, items: [{ id: 'm1', from: 'a', to: 'b', act: 'inform', createdAt: 1000 }] },
    conversationsEnabled: true,
  } };
  let stateIndex = 0;
  const state = { floorInspectionEnabled: enabled, visitorMode: visitor, agents: [{ id: 'a', name: 'A', action: '' }],
    select: () => calls.push('select'), setSidebarTab: () => calls.push('sidebar') };
  const useStore = (selector) => selector(state);
  useStore.getState = () => state;
  const jsx = (type, props) => ({ type, props: props || {} });
  const bridge = new Proxy({}, { get: (_, key) => (...args) => { calls.push(key); return Promise.resolve([]); } });
  const source = fs.readFileSync('src/renderer/src/components/OfficeInspector.tsx', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const mod = { exports: {} };
  const window = { cth: bridge,
    addEventListener: (name, handler) => events.set(name, handler), removeEventListener: () => {}, dispatchEvent: () => {},
  };
  const requireMock = (name) => {
    if (name === 'react') return { useState: (initial) => [stateIndex++ === 0 ? (enabled && !visitor ? detail : null) : initial, () => {}],
      useEffect: (fn) => effects.push(fn), useRef: (value) => ({ current: value }) };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
    if (name === 'react-i18next') return { useTranslation: () => ({ t: (key) => key }) };
    if (name.endsWith('useDirection')) return { useRtl: () => false };
    if (name.endsWith('store/store')) return { useStore };
    if (name.endsWith('PixelButton')) return { PixelButton: 'button' };
    if (name.endsWith('PixelPanel')) return { PixelPanel: 'section' };
    throw new Error('Unexpected component dependency: ' + name);
  };
  vm.runInNewContext('(function(require,module,exports){' + compiled + '\n})', { window, CustomEvent: class {} })(requireMock, mod, mod.exports);
  const tree = mod.exports.OfficeInspector();
  for (const effect of effects) effect();
  const nodes = [];
  function walk(node) {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') { nodes.push(node); return; }
    if (typeof node.type === 'function') return walk(node.type(node.props));
    nodes.push(node); walk(node.props.children);
  }
  walk(tree);
  return { calls, nodes, events };
}

test('inspection reads the floor snapshot without requesting another messages feed', () => {
  const { calls } = renderInspector();
  assert.deepEqual(calls, []);
});

test('inspection does not navigate into the reply composer', () => {
  const { nodes, calls } = renderInspector('engineering');
  for (const node of nodes) if (node.type === 'button') node.props.onClick?.();
  assert.deepEqual(calls, []);
});

test('captured availability is labelled as a snapshot and invalidated on scene reset', () => {
  const { nodes, events } = renderInspector();
  assert.ok(nodes.includes('floorInspector.snapshotNotice'));
  assert.ok(events.has('cth:floor-inspection-reset'));
});

test('disabled inspection and visitor mode create no listeners or bridge requests', () => {
  for (const options of [{ enabled: false }, { visitor: true }]) {
    const { calls, events, nodes } = renderInspector('briefing', options);
    assert.deepEqual(calls, []);
    assert.equal(events.size, 0);
    assert.deepEqual(nodes, []);
  }
});

test('keyboard target selection has an accessible label and the dialog accepts focus', () => {
  const { nodes } = renderInspector();
  assert.equal(nodes.find((node) => node.type === 'select')?.props['aria-label'], 'floorInspector.chooseTarget');
  assert.equal(nodes.find((node) => node.type === 'aside')?.props.tabIndex, -1);
});
