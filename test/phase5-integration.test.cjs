const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { startStationActivity } = loadTs('src/renderer/src/scene/office/stationActivity.ts');
test('stations reuse externally owned movement without disposing it', () => {
  let disposed = 0;
  const movement = { dispose() { disposed++; } };
  const noop = () => {};
  const session = startStationActivity(true, () => ({
    movement,
    map: {width:1,height:1,isWalkable:()=>true},
    director:{now:()=>0,schedule:()=>0,clear:noop,eligible:()=>false,show:noop,hide:noop,visit:()=>false,cancel:noop},
    onHook:()=>noop,onParser:()=>noop,onExit:()=>noop,
  }));
  assert.equal(session.movement, movement);
  session.dispose(); assert.equal(disposed, 0);
});

// Execute the production orchestration, with only rendering and store seams
// replaced. These checks exercise callbacks rather than matching source text.
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync('src/renderer/src/scene/office/OfficeFloor.tsx', 'utf8');
const ast = ts.createSourceFile('OfficeFloor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, `missing production declaration ${name}`);
  return result;
}
function sceneHarness(enabled = true) {
  const program = `
    const movementCoordinationEnabled = enabled, stationActivityEnabled = true;
    const movementBlocks = enabled ? new Set() : null;
    const events = [], activeMoves = new Map(), agents = new Map(), runtimes = new Map();
    const character = new Proxy({}, {get: (_, method) => (...args) => events.push([method, ...args])});
    const stations = { owns: () => false, block: id => events.push(['block', id]), unblock() {} };
    const releaseBreak = rt => { events.push(['releaseBreak']); rt.brk = undefined; };
    const releaseErrand = rt => { events.push(['releaseErrand']); rt.err = undefined; };
    const releaseRun = rt => { events.push(['releaseRun']); rt.run = undefined; };
    const cancelBoardMove = (id, restore) => { events.push(['cancelCard', id, restore]); activeMoves.delete(id); };
    const thought = () => '', t = key => key;
    const agentById = id => agents.get(id);
    const applyState = ${initializer('applyState')};
    const lifecycle = {isCurrent: () => true};
    const finishMove = move => events.push(['finishedCard', move.taskId]);
    const busyActors = new Set();
    const startMove = ${initializer('startMove')};
    return { events, movementBlocks, activeMoves, applyState, startMove,
      add(status) {
        const agent = {id: 'agent', status};
        const rt = {character, waitTile: {x:1,y:2}};
        agents.set(agent.id, agent); runtimes.set(agent.id, rt);
        return {agent, rt};
      }
    };`;
  const output = ts.transpileModule(program, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const { operationalMovementFloor } = loadTs('src/renderer/src/scene/office/movementState.ts');
  return new Function('enabled', 'operationalMovementFloor', output)(enabled, operationalMovementFloor);
}

test('real applyState preempts cafe, errands and cards for an operational block', () => {
  const h = sceneHarness();
  const {agent, rt} = h.add('blocked');
  rt.brk = {}; rt.err = {}; rt.run = {};
  h.activeMoves.set(agent.id, {});
  h.applyState(agent, rt);
  assert.equal(rt.brk, undefined);
  assert.equal(rt.err, undefined);
  assert.equal(rt.run, undefined);
  assert.deepEqual(h.events[0], ['setMovementFloor', 'blocked']);
  assert.ok(h.events.some(e => e[0] === 'cancelCard' && e[2] === false));
  assert.deepEqual(h.events.at(-1), ['walkToTile', rt.waitTile, 'blocked']);
});

test('real applyState honors breaker state independent of Agent.status', () => {
  const h = sceneHarness();
  const {agent, rt} = h.add('idle');
  h.movementBlocks.add(agent.id);
  h.applyState(agent, rt);
  assert.ok(h.events.some(e => e[0] === 'sitAtDesk' && e[2] === 'blocked'));
  assert.ok(!h.events.some(e => e[0] === 'startWandering'));
  h.movementBlocks.delete(agent.id);
  h.events.length = 0;
  h.applyState(agent, rt, true);
  assert.deepEqual(h.events[0], ['setMovementFloor', null]);
  assert.ok(h.events.some(e => e[0] === 'startWandering'));
});

test('real applyState never creates a movement floor while the flag is off', () => {
  const h = sceneHarness(false);
  const {agent, rt} = h.add('working');
  h.applyState(agent, rt);
  assert.equal(h.movementBlocks, null);
  assert.ok(!h.events.some(e => e[0] === 'setMovementFloor'));
});

test('queued card choreography cannot displace current operational work or blocks', () => {
  for (const status of ['working', 'thinking', 'waiting', 'blocked', 'looping', 'compacting', 'ghost']) {
    const h = sceneHarness();
    h.add(status);
    h.startMove({actorId: 'agent', taskId: 'real-ledger-task'});
    assert.deepEqual(h.events, [['finishedCard', 'real-ledger-task']]);
    assert.equal(h.activeMoves.size, 0);
  }
});
test('operational blocks and independently observed breaker suppress optional motion', () => {
  const { operationalMovementFloor } = loadTs('src/renderer/src/scene/office/movementState.ts');
  for (const status of ['blocked','looping','compacting','ghost']) assert.equal(operationalMovementFloor(status,false),'blocked');
  for (const status of ['working','idle','success','waiting','thinking']) {
    assert.equal(operationalMovementFloor(status,false),null);
    assert.equal(operationalMovementFloor(status,true),'blocked');
  }
});
