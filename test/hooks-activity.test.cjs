'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { static isSupported() { return false; } } }
};
const { HookServer } = loadTs('src/main/hooks.ts');

function floor({ control, onEvent } = {}) {
  const sent = [];
  const sessions = [];
  const hive = {
    recordSession: (...args) => sessions.push(args),
    isGod: () => false
  };
  const server = new HookServer(hive, () => ({ send: (...args) => sent.push(args) }),
    () => ({ notifications: false }), control, undefined, undefined, onEvent);
  return {
    fire: (payload) => server.handle({ agent_id: 'jim-1', ...payload }),
    events: () => sent.filter(([channel]) => channel === 'hive:hookEvent').map(([, event]) => event),
    sent, sessions
  };
}

test('main stamps receipt before observers and preserves real correlation IDs', (t) => {
  let clock = 100;
  t.mock.method(Date, 'now', () => clock);
  const { fire, events } = floor({ onEvent: () => { clock = 200; } });
  fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's1',
    tool_use_id: 'call-1', source: 'startup', receivedAt: 5, provenance: 'parser' });
  const event = events()[0];
  assert.equal(event.receivedAt, 100);
  assert.equal(event.provenance, 'hook');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.invocationId, 'call-1');
  assert.equal(event.source, 'startup');
  assert.equal(event.toolPhase, 'requested');
});

test('operator denials retain the hook boundary but never claim a requested tool is active', () => {
  for (const halt of [false, true]) {
    const control = {
      shouldHalt: () => halt,
      toolDecision: () => ({ deny: true, reason: 'Paused by operator' })
    };
    const { fire, events, sent } = floor({ control });
    const result = fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
      session_id: 's1', tool_use_id: 'call-1' });
    assert.equal(events().length, 1);
    assert.equal(events()[0].event, 'PreToolUse');
    assert.equal(events()[0].toolPhase, 'denied');
    assert.equal(events()[0].blocked, true);
    assert.equal(events()[0].invocationId, 'call-1');
    if (halt) assert.equal(result.continue, false);
    else {
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(sent.some(([channel]) => channel === 'control:approvalRequest'), true);
    }
  }
});

test('tool result boundaries distinguish completion, failure, and provider denial', () => {
  const { fire, events } = floor();
  for (const [event, phase] of [
    ['PostToolUse', 'completed'], ['PostToolUseFailure', 'failed'], ['PermissionDenied', 'denied']
  ]) {
    fire({ hook_event_name: event, tool_name: 'Read', tool_use_id: 'call-1' });
    assert.equal(events().at(-1).toolPhase, phase);
  }
  fire({ hook_event_name: 'Stop' });
  assert.equal(events().at(-1).toolPhase, undefined);
});

test('missing or invalid source IDs are never invented or taken from earlier sessions', () => {
  const { fire, events } = floor();
  fire({ hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 'old', tool_use_id: 'old-call' });
  for (const ids of [{}, { session_id: '', tool_use_id: '' }, { session_id: 42, tool_use_id: {} },
    { session_id: ' ', tool_use_id: ' ' }]) {
    fire({ hook_event_name: 'PostToolUse', tool_name: 'Read', ...ids });
    assert.equal(events().at(-1).sessionId, undefined);
    assert.equal(events().at(-1).invocationId, undefined);
  }
  fire({ hook_event_name: 'SessionStart', session_id: 'new' });
  assert.equal(events().at(-1).sessionId, 'new');
  assert.equal(events().at(-1).invocationId, undefined);
});

test('proxy tool announcements are requests even when their legacy event says PostToolUse', () => {
  const { fire, events } = floor();
  fire({ hook_event_name: 'PostToolUse', provenance: 'proxy', tool_name: 'Bash', toolPhase: 'completed' });
  assert.equal(events()[0].event, 'PostToolUse');
  assert.equal(events()[0].provenance, 'proxy');
  assert.equal(events()[0].toolPhase, 'requested');
  assert.equal(events()[0].invocationId, undefined);
});

test('proxy launch key is not exposed as a real provider session ID', () => {
  const { fire, events } = floor();
  fire({ hook_event_name: 'PostToolUse', provenance: 'proxy', tool_name: 'Bash',
    session_id: 'proxy-agent-local-hash', tool_use_id: 'actual-tool-id' });
  assert.equal(events()[0].sessionId, undefined);
  assert.equal(events()[0].invocationId, 'actual-tool-id');
});

function proxyFixture(api = 'openai') {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('typescript');
  const file = path.resolve(__dirname, '../src/main/hive.ts');
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let initializer;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(ast) === 'PROXY_BRIDGE_SHIM') initializer = declaration.initializer.getText(ast);
    }
  }
  assert.ok(initializer, 'execute the real generated sidecar');
  const shim = vm.runInNewContext(initializer);
  const emitted = [];
  let idle;
  const sandbox = {
    require(name) {
      if (name === 'http') return { createServer: () => ({ on() {}, listen() {} }) };
      if (name === 'net') return {
        createConnection(_sock, connected) {
          queueMicrotask(connected);
          return { on() {}, end(line) { emitted.push(JSON.parse(line)); } };
        }
      };
      return require(name);
    },
    process: { env: { HIVE_SOCK: 'fixture', AGENT_ID: 'jim-1', HIVE_PROXY_SESSION: 'proxy-session', HIVE_PROXY_API: api } },
    setTimeout(fn) { idle = fn; return { unref() {} }; },
    clearTimeout() { idle = undefined; }
  };
  vm.runInNewContext(shim, sandbox);
  return { emitted, parse: sandbox.parseAndEmit, finish: () => idle() };
}

test('generated proxy shim labels its actual emitted requests and synthetic idle signal', async () => {
  const { emitted, parse, finish } = proxyFixture();
  parse(JSON.stringify({ choices: [{ message: { tool_calls: [
    { id: 'real-provider-id', function: { name: 'Bash', arguments: '{}' } }
  ] } }] }), false);
  await Promise.resolve();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].provenance, 'proxy');
  assert.equal(emitted[0].toolPhase, 'requested');
  assert.equal(emitted[0].hook_event_name, 'PostToolUse', 'retain legacy operational event');
  parse(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), false);
  finish();
  await Promise.resolve();
  assert.equal(emitted.at(-1).hook_event_name, 'Stop');
  assert.equal(emitted.at(-1).provenance, 'proxy');
});

test('proxy retains supplied tool IDs across response formats without synthesizing missing IDs', async () => {
  const fixtures = [
    ['openai', false, [{ choices: [{ message: { tool_calls: [
      { id: 'call-1', function: { name: 'Read', arguments: '{}' } },
      { function: { name: 'Read', arguments: '{}' } }
    ] } }] }]],
    ['openai', true, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'Read', arguments: '{' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } },
        { index: 1, function: { name: 'Read', arguments: '{}' } }] } }] }
    ]],
    ['anthropic', false, [{ content: [
      { type: 'tool_use', id: 'call-1', name: 'Read', input: {} },
      { type: 'tool_use', name: 'Read', input: {} }
    ] }]],
    ['anthropic', true, [
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call-1', name: 'Read', input: {} } },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read', input: {} } }
    ]]
  ];
  for (const [api, streaming, bodies] of fixtures) {
    const { parse, emitted } = proxyFixture(api);
    parse(streaming ? bodies.map((body) => `data: ${JSON.stringify(body)}\n`).join('') : JSON.stringify(bodies[0]), streaming);
    await Promise.resolve();
    assert.equal(emitted.length, 2, `${api} streaming=${streaming}`);
    assert.equal(emitted[0].tool_use_id, 'call-1', `${api} streaming=${streaming}`);
    assert.equal(emitted[1].tool_use_id, undefined, 'absence must remain uncorrelated');
  }
});
