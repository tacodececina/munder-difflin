'use strict';

/** Executable wiring coverage for OfficeFloor's async character startup. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { createSpawnCoordinator } = loadTs('src/renderer/src/scene/office/spawnCoordinator.ts');
const officePath = path.resolve(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx');
const officeSource = fs.readFileSync(officePath, 'utf8');
const ast = ts.createSourceFile(officePath, officeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function variableInitializer(name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node.initializer;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `OfficeFloor production declaration ${name} was not found`);
  return found.getText(ast);
}

function coordinatorOptions() {
  let found;
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(ast) === 'spawns' && ts.isCallExpression(node.right)
        && node.right.expression.getText(ast) === 'createSpawnCoordinator') found = node.right.arguments[0];
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found && ts.isObjectLiteralExpression(found),
    'OfficeFloor must construct createSpawnCoordinator with production options');
  return found.getText(ast);
}

function hasSpawnTeardown() {
  let found = false;
  function visit(node) {
    if (ts.isCallExpression(node) && /spawns\?*\.teardown/.test(node.expression.getText(ast))) found = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

const extracted = {
  claimSeat: variableInitializer('claimSeat'),
  loadCharacter: variableInitializer('loadCharacter'),
  attachCharacter: variableInitializer('attachCharacter'),
  syncAgents: variableInitializer('syncAgents'),
  spawnOptions: coordinatorOptions()
};
assert.equal(hasSpawnTeardown(), true, 'OfficeFloor teardown must invalidate outstanding character loads');

// Pixi is the only stubbed seam: attachCharacter records a runtime instead of
// constructing display objects. Everything around it is extracted production code.
const harnessTs = `
function makeHarness(frameLoader, initialAgents) {
  const seatClaims = new Set();
  const seatTiles = Array.from({ length: 12 }, (_, x) => ({ x, y: 1 }));
  const GOD_SEAT = 0;
  const claimSeat = ${extracted.claimSeat};
  const theme = { cast: {
    byName: new Proxy({}, { get: (_target, name) => ({ shirt: '#123456', name }) }),
    defaultCharacter: 'default', getFrames: frameLoader
  } };
  const isCustomCharacterId = () => false;
  const getCustomCharacter = () => undefined;
  const loadCharacter = ${extracted.loadCharacter};
  const runtimes = new Map();
  const applied = [], attachments = [], removals = [];
  let agents = initialAgents;
  const useStore = { getState: () => ({ agents }) };
  const stationSession = null;
  const requestEconomyRender = () => {};
  const applyState = (agent) => applied.push(agent);
  const attachCharacter = (agent, prepared, seatIndex) => {
    attachments.push({ id: agent.id, character: agent.character, prepared, seatIndex });
    runtimes.set(agent.id, { seatIndex });
  };
  const removeCharacter = (id) => { removals.push(id); runtimes.delete(id); };
  let spawns = createSpawnCoordinator(${extracted.spawnOptions});
  const syncAgents = ${extracted.syncAgents};
  return {
    sync(nextAgents = agents) { agents = nextAgents; syncAgents(); },
    teardown() { spawns?.teardown(); spawns = null; },
    seatClaims, runtimes, attachments, removals, applied
  };
}
function makeMovementFailureHarness(frameLoader, agent) {
  const seatClaims = new Set(), seatTiles = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const GOD_SEAT = 0, waitTiles = [{ x: 9, y: 9 }], entrance = { x: 3, y: 3 };
  const claimSeat = ${extracted.claimSeat};
  const theme = { cast: {
    byName: new Proxy({}, { get: () => ({ shirt: '#123456' }) }),
    defaultCharacter: 'default', getFrames: frameLoader
  } };
  const isCustomCharacterId = () => false, getCustomCharacter = () => undefined;
  const loadCharacter = ${extracted.loadCharacter};
  const destroyed = [], warnings = [], runtimes = new Map();
  class Character {
    constructor(options) { this.agentId = options.agentId; }
    setMovementDirector() { return false; }
    destroy() { destroyed.push(this.agentId); }
  }
  const mapRenderer = { getSpawnPoint: () => entrance };
  const facingForSeat = () => 'up', colors = { accent: {} };
  const hexNum = () => 0, hexToNumber = () => 0;
  const floorInspectionEnabled = false, emitInspection = null;
  const useStore = { getState: () => ({ select() {} }) };
  const movement = {}, movementCoordinationEnabled = true;
  const attachCharacter = ${extracted.attachCharacter};
  const removeCharacter = (id) => {
    const rt = runtimes.get(id); if (!rt) return;
    rt.character.destroy(); runtimes.delete(id);
  };
  const console = { warn: (...args) => warnings.push(args) };
  const spawns = createSpawnCoordinator(${extracted.spawnOptions});
  spawns.sync([agent]);
  return { spawns, seatClaims, runtimes, destroyed, warnings };
}
module.exports = { makeHarness, makeMovementFailureHarness };
`;
const compiled = ts.transpileModule(harnessTs, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const harnessModule = { exports: {} };
new Function('module', 'exports', 'createSpawnCoordinator', compiled)(harnessModule, harnessModule.exports, createSpawnCoordinator);
const { makeHarness, makeMovementFailureHarness } = harnessModule.exports;

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }

test('two production syncs while frames load build and claim once', async () => {
  const frames = deferred(); let loads = 0;
  const agent = { id: 'same', character: 'dwight' };
  const harness = makeHarness(() => { loads++; return frames.promise; }, [agent]);
  harness.sync();
  harness.sync([{ ...agent, status: 'working' }]);
  assert.equal(loads, 1);
  assert.deepEqual([...harness.seatClaims], [1]);
  frames.resolve('dwight-frames'); await flush();
  assert.deepEqual(harness.attachments.map(a => [a.id, a.seatIndex]), [['same', 1]]);
});

test('eleven deferred production loads reserve eleven distinct formal seats', () => {
  const pending = new Map();
  const agents = Array.from({ length: 11 }, (_, i) => ({
    id: `agent-${i}`, character: `character-${i}`, isGod: i === 0
  }));
  const harness = makeHarness((name) => {
    const frames = deferred(); pending.set(name, frames); return frames.promise;
  }, agents);
  harness.sync();
  assert.equal(pending.size, 11);
  assert.deepEqual([...harness.seatClaims].sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i));
});

test('production wiring rejects an old same-id incarnation after remove and re-add', async () => {
  const loads = [deferred(), deferred()]; let index = 0;
  const harness = makeHarness(() => loads[index++].promise, [{ id: 'phoenix', character: 'old' }]);
  harness.sync(); harness.sync([]); harness.sync([{ id: 'phoenix', character: 'new' }]);
  loads[0].resolve('old-frames'); await flush();
  assert.deepEqual(harness.attachments, []);
  assert.deepEqual([...harness.seatClaims], [1]);
  loads[1].resolve('new-frames'); await flush();
  assert.deepEqual(harness.attachments.map(a => [a.character, a.prepared.frames, a.seatIndex]),
    [['new', 'new-frames', 1]]);
});

test('production sync applies the newest agent state after attachment', async () => {
  const frames = deferred();
  const harness = makeHarness(() => frames.promise, [{ id: 'updated', character: 'jim', status: 'idle' }]);
  harness.sync(); frames.resolve('frames'); await flush();
  harness.sync([{ id: 'updated', character: 'jim', status: 'working' }]);
  assert.equal(harness.applied.at(-1).status, 'working');
});

test('production teardown prevents late theme frames from attaching', async () => {
  const frames = deferred();
  const harness = makeHarness(() => frames.promise, [{ id: 'late', character: 'pam' }]);
  harness.sync(); harness.teardown();
  assert.deepEqual([...harness.seatClaims], []);
  frames.resolve('late-frames'); await flush();
  assert.deepEqual(harness.attachments, []);
});

test('production attachment publishes one runtime before fallible graphics setup', () => {
  const attach = extracted.attachCharacter;
  const runtimeRegistration = attach.indexOf('runtimes.set(agent.id, rt)');
  assert.ok(runtimeRegistration > -1, 'attachCharacter no longer registers its runtime');
  assert.ok(runtimeRegistration < attach.indexOf('character.show(charLayer)'),
    'runtime ownership must be published before fallible Pixi display setup');
  assert.equal((attach.match(/const rt: Runtime/g) ?? []).length, 1,
    'attachCharacter must create exactly one runtime ownership record');
});

test('production coordinator cleans a character when movement setup rejects attachment', async () => {
  const harness = makeMovementFailureHarness(async () => 'frames', {
    id: 'blocked-spawn', character: 'jim', accent: 'blue'
  });
  await flush();
  assert.deepEqual(harness.destroyed, ['blocked-spawn']);
  assert.equal(harness.runtimes.size, 0);
  assert.deepEqual([...harness.seatClaims], []);
  assert.equal(harness.warnings.length, 1);
});
