'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { StationConnections } = loadTs('src/renderer/src/scene/office/stationConnections.ts');

function rig({ synchronousExit = false } = {}) {
  const events = [], subscriptions = [];
  const connections = new StationConnections({
    subscribe: (pty, callback) => {
      const subscription = { pty, callback, removed: false };
      subscriptions.push(subscription); events.push(['subscribe', pty]);
      if (synchronousExit) callback();
      return () => {
        subscription.removed = true; events.push(['unsubscribe', pty]);
        // Model a transport delivering a queued callback during unsubscription.
        callback();
      };
    },
    disconnect: id => events.push(['disconnect', id]),
    reconnect: id => events.push(['reconnect', id]),
  });
  return { connections, events, subscriptions };
}

test('binding an unchanged PTY is idempotent and exit disconnects only once', () => {
  const r = rig();
  r.connections.bind('a', 'p1'); r.connections.bind('a', 'p1');
  assert.deepEqual(r.events, [['reconnect', 'a'], ['subscribe', 'p1']]);
  r.subscriptions[0].callback(); r.subscriptions[0].callback();
  assert.equal(r.events.filter(e => e[0] === 'disconnect').length, 1);
  assert.equal(r.subscriptions[0].removed, true);
  r.connections.bind('a', 'p1');
  assert.equal(r.subscriptions.length, 1, 'an ended PTY is not a new connection');
});

test('replacement clears evidence and invalidates old exit before unsubscribe', () => {
  const r = rig(); r.connections.bind('a', 'p1'); r.events.length = 0;
  r.connections.bind('a', 'p2');
  assert.equal(r.events.filter(e => e[0] === 'disconnect').length, 1);
  assert.ok(r.events.findIndex(e => e[0] === 'disconnect') < r.events.findIndex(e => e[0] === 'reconnect'));
  const after = r.events.length;
  r.subscriptions[0].callback();
  assert.equal(r.events.length, after, 'late old exit cannot touch replacement');
  r.subscriptions[1].callback();
  assert.deepEqual(r.events.filter(e => e[0] === 'disconnect'), [['disconnect', 'a'], ['disconnect', 'a']]);
});

test('binding without a PTY disconnects and releases previous subscription', () => {
  const r = rig(); r.connections.bind('a'); r.connections.bind('a');
  assert.deepEqual(r.events, [['disconnect', 'a']]);
  r.connections.bind('a', 'p1'); r.connections.bind('a', undefined);
  assert.equal(r.subscriptions[0].removed, true);
  assert.equal(r.events.filter(e => e[0] === 'disconnect').length, 2);
  assert.equal(r.subscriptions.length, 1);
});

test('remove invalidates callbacks even if the same id and PTY are reused', () => {
  const r = rig(); r.connections.bind('a', 'p1');
  r.connections.remove('a'); r.connections.remove('a');
  r.connections.bind('a', 'p1');
  const count = r.events.length; r.subscriptions[0].callback();
  assert.equal(r.events.length, count);
  assert.equal(r.subscriptions.length, 2);
  assert.equal(r.events.filter(e => e[0] === 'disconnect').length, 1);
});

test('dispose releases every listener and cannot reconnect or bind again', () => {
  const r = rig(); r.connections.bind('a', 'p1'); r.connections.bind('b', 'p2');
  r.connections.dispose();
  assert.ok(r.subscriptions.every(s => s.removed));
  assert.equal(r.events.filter(e => e[0] === 'disconnect').length, 2);
  const count = r.events.length;
  r.connections.dispose(); r.connections.bind('c', 'p3');
  for (const s of r.subscriptions) s.callback();
  assert.equal(r.events.length, count);
});

test('a synchronous exit during subscribe cannot leak its eventual unsubscribe', () => {
  const r = rig({ synchronousExit: true }); r.connections.bind('a', 'p1');
  assert.equal(r.events.filter(e => e[0] === 'disconnect').length, 1);
  assert.equal(r.subscriptions[0].removed, true);
});

test('one agent exit leaves another agent connection intact', () => {
  const r = rig(); r.connections.bind('a', 'p1'); r.connections.bind('b', 'p2');
  r.subscriptions[0].callback();
  assert.equal(r.subscriptions[1].removed, false);
  assert.deepEqual(r.events.filter(e => e[0] === 'disconnect'), [['disconnect', 'a']]);
});
