'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { heldFromReading, readingState } =
  loadTs('src/renderer/src/scene/office/floorReadings.ts');
const floorReadings = loadTs('src/renderer/src/scene/office/floorReadings.ts');

function makeHive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-readings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, root: path.join(home, 'hive') };
}

test('a valid empty ledger is available and has a real valid-read timestamp', (t) => {
  const { hive } = makeHive(t);
  const now = 1_760_000_000_000;
  const reading = hive.tasksReading(now);

  assert.equal(reading.source, 'hive.tasks');
  assert.equal(reading.scope, 'active-hive');
  assert.equal(reading.availability, 'available');
  assert.deepEqual(reading.value, { tasks: [] });
  assert.equal(reading.lastAccessedAt, now);
  assert.equal(reading.lastValidAt, now);
});

test('a corrupt ledger keeps the last valid read but does not re-date it', (t) => {
  const { hive, root } = makeHive(t);
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'real', status: 'doing' }
  ] }), 'utf8');
  const first = hive.tasksReading(1000);
  fs.writeFileSync(path.join(root, 'tasks.json'), '{ broken', 'utf8');

  const second = hive.tasksReading(2000);
  assert.equal(second.availability, 'unavailable');
  assert.deepEqual(second.value, first.value);
  assert.equal(second.lastAccessedAt, 2000);
  assert.equal(second.lastValidAt, 1000);
  assert.notEqual(second.lastAccessedAt, second.lastValidAt);
});

test('floor held readings use the last valid read, never the access time', () => {
  const reading = {
    source: 'hive.tasks', scope: 'active-hive', value: { tasks: [] },
    availability: 'unavailable', lastAccessedAt: 2000, lastValidAt: 1000
  };
  assert.deepEqual(heldFromReading(reading), { value: { tasks: [] }, at: 1000 });
  assert.equal(readingState(reading, 1000, 500), 'unavailable');
  assert.equal(readingState(reading, 1501, 500), 'expired');
});

test('parseable non-ledgers cannot replace the last valid task reading', (t) => {
  const { hive, root } = makeHive(t);
  const good = hive.tasksReading(1000);
  for (const value of [null, {}, [], { tasks: 'missing' }]) {
    fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(value));
    hive.tasks(); // Other consumers must not poison the shared good-read cache.
    const reading = hive.tasksReading(2000);
    assert.equal(reading.availability, 'unavailable');
    assert.equal(reading.lastValidAt, good.lastValidAt);
    assert.deepEqual(reading.value, good.value);
  }
});

test('visible task cards require fresh available evidence and never default a missing status', () => {
  const reading = { value: { tasks: [{ id: 'real', status: 'doing' }] }, lastValidAt: 1000, availability: 'available' };
  assert.equal(typeof floorReadings.visibleTaskLedger, 'function');
  const visible = floorReadings.visibleTaskLedger;
  assert.deepEqual(visible(reading, 1000, 500), reading.value.tasks);
  assert.equal(visible({ ...reading, availability: 'unavailable' }, 1000, 500), null);
  assert.equal(visible(reading, 1500, 500), null);
  for (const tasks of [[{ id: 'real' }], [{ status: 'done' }], [null], [{ id: 'real', status: 'guess' }]]) {
    assert.equal(visible({ ...reading, value: { tasks } }, 1000, 500), null);
  }
  assert.deepEqual(visible({ ...reading, value: { tasks: [] } }, 1000, 500), []);
});

test('a missing or corrupt log is unavailable, while a readable empty log is a measured zero', (t) => {
  const { hive, root } = makeHive(t);
  assert.equal(typeof hive.logReading, 'function');
  const file = path.join(root, 'log.jsonl');
  fs.rmSync(file, { force: true });
  assert.equal(hive.logReading(100, 1000).availability, 'unavailable');
  fs.writeFileSync(file, '');
  assert.deepEqual(hive.logReading(100, 2000).value, []);
  assert.equal(hive.logReading(100, 2000).availability, 'available');
  fs.writeFileSync(file, '{ broken');
  assert.equal(hive.logReading(100, 3000).availability, 'unavailable');
  fs.writeFileSync(file, JSON.stringify({ kind: 'task_done', taskId: 'a', ts: 1000 }));
  assert.equal(hive.logReading(100, 4000).value[0].taskId, 'a');
});

test('a non-ledger cannot reset completion observation and re-celebrate an old closure', (t) => {
  const { hive, root } = makeHive(t);
  const file = path.join(root, 'tasks.json');
  const write = (value) => fs.writeFileSync(file, JSON.stringify(value));
  write({ tasks: [{ id: 'real', status: 'doing' }] });
  assert.deepEqual(hive.observeTaskCompletions(), []);
  write({ tasks: [{ id: 'real', status: 'done' }] });
  assert.deepEqual(hive.observeTaskCompletions(), ['real']);
  write({ tasks: [{ id: 'real' }] });
  assert.deepEqual(hive.observeTaskCompletions(), []);
  write({ tasks: [{ id: 'real', status: 'done' }] });
  assert.deepEqual(hive.observeTaskCompletions(), []);
});
