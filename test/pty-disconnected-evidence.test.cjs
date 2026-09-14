'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { validateHookEvent } = loadTs('src/shared/hookEvents.ts');

/** Execute the actual teardown and kill IPC bodies without booting Electron. */
function runtimeFixture() {
  const filename = path.resolve(__dirname, '../src/main/index.ts');
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const teardown = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'teardownPty');
  let kill;
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) === 'ipcMain.handle' && call.arguments[0]?.text === 'pty:kill') kill = call.arguments[1];
  }
  assert.ok(teardown && kill, 'exercise the actual production lifecycle');
  const events = [], archived = [], killed = [];
  const ptyToAgent = new Map([['pty-god', 'god-1'], ['pty-worker', 'worker-1'], ['pty-regular', 'regular-1']]);
  const liveWorkers = new Map([['pty-worker', {}]]);
  const context = {
    ptyToAgent, liveWorkers, validateHookEvent,
    integrationBroker: { revoke() {} }, workerWake: { forget() {} }, breaker: { forget() {} }, telemetry: { forgetAgent() {} },
    hive: { stopProxyBridge() {}, enabled: () => true, registry: () => ({ godId: 'god-1' }), setArchived: (...args) => archived.push(args) },
    worktreePaths: new Map(), worktreeOrigins: new Map(), syncKeepAwake() {},
    liveWebContents: () => ({ send: (...args) => events.push(args) }),
    remoteManager: { has: () => false },
    ptyManager: { kill: (id) => { killed.push(id); return { ok: true }; } },
    Date: { now: () => 1234 }, console
  };
  const source = `${teardown.getText(ast)}\nconst killHandler = ${kill.getText(ast)}; globalThis.fireKill = killHandler; globalThis.fireTeardown = teardownPty;`;
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { ...context, events, archived, killed };
}

test('explicit kill emits real disconnect evidence for god, workers, and regular agents', () => {
  const fixture = runtimeFixture();
  for (const [pty, agentId] of [['pty-god', 'god-1'], ['pty-worker', 'worker-1'], ['pty-regular', 'regular-1']]) {
    assert.equal(fixture.fireKill({}, pty).ok, true);
    const evidence = fixture.events.filter(([channel]) => channel === 'hive:hookEvent').at(-1)?.[1];
    assert.ok(evidence, 'explicit kill must invalidate visual activity even without pty:exit');
    assert.equal(evidence.event, 'PtyDisconnected');
    assert.equal(evidence.agentId, agentId);
    assert.equal(evidence.provenance, 'runtime');
    assert.equal(evidence.receivedAt, 1234);
    assert.equal(validateHookEvent(evidence), true);
  }
  assert.deepEqual(fixture.killed, ['pty-god', 'pty-worker', 'pty-regular']);
  assert.equal(fixture.archived.some(([id]) => id === 'god-1'), false);
  assert.equal(fixture.events.some(([channel]) => channel.startsWith('pty:exit')), false);
  const before = fixture.events.filter(([channel]) => channel === 'hive:hookEvent').length;
  fixture.fireTeardown('pty-god');
  fixture.fireTeardown('unknown-pty');
  assert.equal(fixture.events.filter(([channel]) => channel === 'hive:hookEvent').length, before,
    'unknown or already removed PTYs cannot manufacture agent identities');
});
