'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { validateHookEvent } = loadTs('src/shared/hookEvents.ts');

test('accepts valid hook event payloads', () => {
  assert.equal(validateHookEvent({
    agentId: 'jim-1',
    event: 'PreToolUse',
    tool: 'Bash',
    notificationType: 'permission',
    source: 'claude',
    message: 'Running a command',
    blocked: false
  }), true);
});

test('accepts optional agent ids and open provider event names', () => {
  assert.equal(validateHookEvent({ event: 'Stop' }), true);
  assert.equal(validateHookEvent({ agentId: 'jim-1', event: 'Unknown' }), true);
  assert.equal(validateHookEvent({ agentId: 'jim-1', event: 'FutureProviderEvent' }), true);
});

test('rejects payloads missing a valid event name', () => {
  assert.equal(validateHookEvent({ agentId: 'jim-1' }), false);
  assert.equal(validateHookEvent({ agentId: 'jim-1', event: '' }), false);
  assert.equal(validateHookEvent({ agentId: 'jim-1', event: 42 }), false);
});

test('rejects malformed optional fields', () => {
  assert.equal(validateHookEvent({ agentId: '', event: 'Stop' }), false);
  assert.equal(validateHookEvent({ agentId: 'jim-1', event: 'PreToolUse', tool: 42 }), false);
  assert.equal(validateHookEvent({ agentId: 'jim-1', event: 'Stop', blocked: 'false' }), false);
  assert.equal(validateHookEvent(null), false);
});

test('validates optional activity evidence while accepting legacy events', () => {
  const evidence = {
    event: 'PreToolUse', provenance: 'hook', receivedAt: 123,
    sessionId: 'session-1', invocationId: 'tool-1', toolPhase: 'requested'
  };
  assert.equal(validateHookEvent(evidence), true);
  for (const provenance of ['hook', 'proxy', 'parser', 'runtime']) {
    assert.equal(validateHookEvent({ ...evidence, provenance }), true);
  }
  for (const toolPhase of ['requested', 'denied', 'completed', 'failed']) {
    assert.equal(validateHookEvent({ ...evidence, toolPhase }), true);
  }
  for (const patch of [
    { provenance: 'native' }, { provenance: 1 }, { receivedAt: '123' },
    { receivedAt: NaN }, { receivedAt: Infinity }, { receivedAt: -1 },
    { sessionId: '' }, { sessionId: 123 }, { invocationId: '' },
    { invocationId: null }, { toolPhase: 'running' }
  ]) assert.equal(validateHookEvent({ ...evidence, ...patch }), false, JSON.stringify(patch));
});

test('main and preload share the hook event contract', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/hooks.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');

  assert.match(main, /validateHookEvent.*shared\/hookEvents|shared\/hookEvents.*validateHookEvent/s);
  assert.match(preload, /HookEvent.*shared\/hookEvents|shared\/hookEvents.*HookEvent/s);
  assert.match(preload, /payload: HookEvent/);
});
