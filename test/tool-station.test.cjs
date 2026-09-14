const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { stationForTool } = loadTs('src/shared/toolStation.ts');
const channel = loadTs('src/renderer/src/scene/office/toolActivityChannel.ts');

test('one taxonomy handles native, alternate-provider and unknown tool names', () => {
  for (const [tools, station] of [
    [['Read','Grep','Glob','list_dir','read_file'], 'shelf'],
    [['Edit','Write','MultiEdit','write_file','apply_patch'], 'desk'],
    [['Bash','BashOutput','run_command'], 'terminal'],
    [['WebFetch','WebSearch','browser_open'], 'web'],
    [['TodoWrite','TaskCreate','TaskUpdate'], 'board'],
    [['Task'], 'mailbox'], [['mcp__real__call'], 'mcp'], [['Unknown','constructor','toString'], 'desk'],
  ]) for (const tool of tools) assert.equal(stationForTool(tool).station, station, tool);
});

test('parser channel keeps no replay history and releases its last listener', () => {
  const calls = [];
  channel.observeParserTool({event:'before'});
  const off = channel.subscribeParserTools(event => calls.push(event.event));
  channel.observeParserTool({event:'during'});
  off(); channel.observeParserTool({event:'after'});
  const off2 = channel.subscribeParserTools(event => calls.push(event.event));
  assert.deepEqual(calls, ['during']); off2(); off();
});

test('all four locales have real text, tool interpolation, and explicit default-off copy', () => {
  for (const lang of ['en','es','ar','zh-CN']) {
    const locale = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', lang+'.json'), 'utf8'));
    const labels = locale.office.stationActivity;
    for (const phase of ['requested','denied','completed','failed','observed']) {
      assert.ok(labels[phase].includes('{{tool}}'));
      assert.ok(!labels[phase].includes('?'), `${lang}/${phase} lost Unicode`);
    }
    assert.ok(!locale.settings.general.stationActivityDesc.includes('?'));
    if (lang === 'ar') assert.match(labels.requested, /[\u0600-\u06ff]/);
    if (lang === 'zh-CN') assert.match(labels.requested, /[\u4e00-\u9fff]/);
  }
});
