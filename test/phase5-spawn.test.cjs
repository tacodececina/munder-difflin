'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { createSpawnCoordinator } = loadTs(
  'src/renderer/src/scene/office/spawnCoordinator.ts');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('concurrent syncs build one incarnation for the same id', async () => {
  const texture = deferred();
  const builds = [];
  const attached = [];
  const claimed = new Set();
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => { claimed.add(4); return 4; },
    release: (seat) => claimed.delete(seat),
    build: (agent) => { builds.push(agent.id); return texture.promise; },
    attach: (_agent, built, context) => attached.push([built, context.seat])
  });

  coordinator.sync([{ id: 'same' }]);
  coordinator.sync([{ id: 'same' }]);
  assert.deepEqual(builds, ['same']);
  assert.deepEqual([...claimed], [4]);

  texture.resolve('texture');
  await flush();
  assert.deepEqual(attached, [['texture', 4]]);
});

test('eleven unique agents reserve eleven different seats while loading', () => {
  const pending = Array.from({ length: 11 }, deferred);
  const claimed = new Set();
  let nextSeat = 0;
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => { const seat = nextSeat++; claimed.add(seat); return seat; },
    release: (seat) => claimed.delete(seat),
    build: (_agent, context) => pending[context.seat].promise,
    attach: () => {}
  });

  coordinator.sync(Array.from({ length: 11 }, (_, i) => ({ id: `agent-${i}` })));
  assert.deepEqual([...claimed], Array.from({ length: 11 }, (_, i) => i));
});

test('an agent removed during loading immediately releases its own claim', () => {
  const texture = deferred();
  const released = [];
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => 7,
    release: (seat) => released.push(seat),
    build: () => texture.promise,
    attach: () => {}
  });
  coordinator.sync([{ id: 'gone' }]);
  coordinator.sync([]);
  assert.deepEqual(released, [7]);
});

test('an old same-id promise cannot attach or release the new incarnation', async () => {
  const oldTexture = deferred();
  const newTexture = deferred();
  const promises = [oldTexture, newTexture];
  const released = [];
  const attached = [];
  let nextSeat = 1;
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => nextSeat++,
    release: (seat) => released.push(seat),
    build: () => promises.shift().promise,
    attach: (_agent, built, context) => attached.push([built, context.seat])
  });

  coordinator.sync([{ id: 'phoenix' }]);
  coordinator.remove('phoenix');
  coordinator.sync([{ id: 'phoenix' }]);
  oldTexture.resolve('old');
  await flush();
  assert.deepEqual(attached, []);
  assert.deepEqual(released, [1]);

  newTexture.resolve('new');
  await flush();
  assert.deepEqual(attached, [['new', 2]]);
  assert.deepEqual(released, [1]);
});

test('teardown makes late resolutions inert and releases all current claims', async () => {
  const texture = deferred();
  const attached = [];
  const discarded = [];
  const released = [];
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => null,
    release: (seat) => released.push(seat),
    build: () => texture.promise,
    attach: (...args) => attached.push(args),
    discard: (built) => discarded.push(built)
  });
  coordinator.sync([{ id: 'late' }]);
  coordinator.teardown();
  texture.resolve('late-texture');
  await flush();
  assert.deepEqual(released, [null], 'null is a valid no-formal-desk reservation');
  assert.deepEqual(attached, []);
  assert.deepEqual(discarded, ['late-texture']);
});

test('a failed build releases its claim and a later sync retries', async () => {
  const first = deferred();
  const second = deferred();
  const loads = [first, second];
  const released = [];
  const errors = [];
  let builds = 0;
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => 3,
    release: (seat) => released.push(seat),
    build: () => { builds++; return loads.shift().promise; },
    attach: () => {},
    onError: (error) => errors.push(error.message)
  });
  coordinator.sync([{ id: 'retry' }]);
  first.reject(new Error('texture failed'));
  await flush();
  assert.deepEqual(released, [3]);
  assert.deepEqual(errors, ['texture failed']);

  coordinator.sync([{ id: 'retry' }]);
  assert.equal(builds, 2);
  second.resolve('ok');
  await flush();
});

test('attach failure reports the error, discards the built value and releases once', async () => {
  const discarded = [];
  const released = [];
  const errors = [];
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => 9,
    release: (seat) => released.push(seat),
    build: async () => ({ texture: 'frames' }),
    attach: () => { throw new Error('attach failed'); },
    discard: (built) => discarded.push(built.texture),
    onError: (error) => errors.push(error.message)
  });
  coordinator.sync([{ id: 'broken-attach' }]);
  await flush();
  assert.deepEqual(released, [9]);
  assert.deepEqual(discarded, ['frames']);
  assert.deepEqual(errors, ['attach failed']);
});

test('removing an attached record detaches before releasing and retains no built value', async () => {
  const events = [];
  let built = { large: true };
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => 5,
    release: (seat) => events.push(`release:${seat}`),
    build: async () => built,
    attach: () => events.push('attach'),
    detach: (id) => events.push(`detach:${id}`)
  });
  coordinator.sync([{ id: 'resident' }]);
  await flush();
  built = null;
  coordinator.remove('resident');
  assert.deepEqual(events, ['attach', 'detach:resident', 'release:5']);
  assert.equal(coordinator.has('resident'), false);
});

test('a detach error is reported after the claim is safely released', async () => {
  const events = [];
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => 6,
    release: (seat) => events.push(`release:${seat}`),
    build: async () => 'built',
    attach: () => {},
    detach: () => { events.push('detach'); throw new Error('detach failed'); },
    onError: (error) => events.push(`error:${error.message}`)
  });
  coordinator.sync([{ id: 'fragile' }]);
  await flush();
  assert.doesNotThrow(() => coordinator.remove('fragile'));
  assert.deepEqual(events, ['detach', 'release:6', 'error:detach failed']);
});

test('attach may remove and re-add the same id without leaving the old built value visible', async () => {
  const oldTexture = deferred();
  const newTexture = deferred();
  const loads = [oldTexture, newTexture];
  const events = [];
  let coordinator;
  let attachCount = 0;
  coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => attachCount + 1,
    release: (seat) => events.push(`release:${seat}`),
    build: () => loads.shift().promise,
    attach: (_agent, built) => {
      attachCount++;
      events.push(`attach:${built}`);
      if (built === 'old') {
        coordinator.remove('same');
        coordinator.sync([{ id: 'same' }]);
      }
    },
    detach: (id) => events.push(`detach:${id}`)
  });
  coordinator.sync([{ id: 'same' }]);
  oldTexture.resolve('old');
  await flush();
  assert.deepEqual(events, ['attach:old', 'detach:same', 'release:1']);
  assert.equal(coordinator.has('same'), true);

  newTexture.resolve('new');
  await flush();
  assert.deepEqual(events, ['attach:old', 'detach:same', 'release:1', 'attach:new']);
});

test('an old attach throw after re-adding cannot erase the new record', async () => {
  const first = deferred();
  const second = deferred();
  const loads = [first, second];
  const errors = [];
  let coordinator;
  coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => 2,
    release: () => {},
    build: () => loads.shift().promise,
    attach: (_agent, built) => {
      if (built === 'old') {
        coordinator.remove('same');
        coordinator.sync([{ id: 'same' }]);
        throw new Error('old attach failed');
      }
    },
    onError: (error) => errors.push(error.message)
  });
  coordinator.sync([{ id: 'same' }]);
  first.resolve('old');
  await flush();
  assert.equal(coordinator.has('same'), true);
  assert.deepEqual(errors, ['old attach failed']);
  second.resolve('new');
  await flush();
  assert.equal(coordinator.has('same'), true);
});

test('reserve and synchronous build throws are reported and remain retryable', () => {
  const errors = [];
  let reserveThrows = true;
  let buildThrows = true;
  const coordinator = createSpawnCoordinator({
    keyOf: (agent) => agent.id,
    reserve: () => {
      if (reserveThrows) { reserveThrows = false; throw new Error('reserve failed'); }
      return 8;
    },
    release: () => {},
    build: () => {
      if (buildThrows) { buildThrows = false; throw new Error('build failed'); }
      return new Promise(() => {});
    },
    attach: () => {},
    onError: (error) => errors.push(error.message)
  });
  assert.doesNotThrow(() => coordinator.sync([{ id: 'retry' }]));
  assert.doesNotThrow(() => coordinator.sync([{ id: 'retry' }]));
  assert.doesNotThrow(() => coordinator.sync([{ id: 'retry' }]));
  assert.deepEqual(errors, ['reserve failed', 'build failed']);
  assert.equal(coordinator.has('retry'), true);
});
