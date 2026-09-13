'use strict';

// Office VOICES — the break-room dialogue said out loud through MiniMax TTS
// (src/main/officeVoices.ts + src/main/minimaxTts.ts).
//
// The promises this file holds the feature to, in the order they matter:
//
//   1. THE FLAG IS A WALL. With `officeVoicesEnabled` off, NOTHING happens: the
//      gate refuses before it reads the API key, no request is dispatched, and
//      the per-minute ledger is untouched. Same standard of inertia the chatter
//      experiments already meet.
//   2. A VOICE IS AN IDENTITY, NOT A ROLL OF THE DICE. The same agent resolves
//      to the same voice every time, on every machine, forever: fixed cast
//      members from a hand-written map, everyone else from a stable hash. An
//      explicit per-agent pin beats both.
//   3. IT DEGRADES INTO SILENCE. No key, an endpoint that is down, a 500, a
//      MiniMax application error inside a 200, a body that is not JSON, a
//      timeout — every one of them yields no audio and no exception. The floor's
//      written dialogue is never involved.
//   4. THE RATE LIMIT BINDS, IN MAIN. A rolling one-minute ceiling stops clips
//      being synthesised no matter how fast the floor asks, and reopens as the
//      window slides.
//   5. THE KEY STAYS PUT. Authorization header only — never in the body, never
//      in a returned string.
//
// NOTHING here touches a real service: every request goes to a throwaway
// `node:http` server bound to 127.0.0.1 on an ephemeral port. There is no
// MiniMax account, no key and no network egress anywhere in this file.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const {
  voiceIdFor,
  planSpeech,
  speakableText,
  hashString,
  VoicePlayLedger,
  CAST_VOICES,
  FALLBACK_VOICES,
  MAX_SPEAK_CHARS,
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_VOICE_PLAYS_PER_MINUTE
} = loadTs('src/main/officeVoices.ts');
const {
  synthesizeSpeech,
  decodeHexAudio,
  ttsUrl,
  TTS_MIME_TYPE
} = loadTs('src/main/minimaxTts.ts');

/** The 15 fixed Office characters, mirrored from the renderer's
 *  scene/office/cast.ts. Duplicated on purpose: main cannot import renderer
 *  code, and this list is exactly what makes "the cast map is complete" a test
 *  rather than a hope. */
const OFFICE_CAST = [
  'michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley',
  'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'
];

/** A fake MiniMax T2A endpoint. `handler(req, res, body)` decides what it does;
 *  `server.hits` records every request it saw, headers included, so a test can
 *  assert on the Authorization header — and, more importantly, assert that a
 *  refused request produced NO hit at all. */
async function fakeMinimax(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    hits,
    endpoint: `http://127.0.0.1:${port}/v1/t2a_v2`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Some recognisable bytes, hex-encoded the way T2A v2 answers. */
const CLIP_BYTES = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 0x42, 0x13]);
const CLIP_HEX = Buffer.from(CLIP_BYTES).toString('hex');

const okBody = (hex = CLIP_HEX) => JSON.stringify({
  data: { audio: hex, status: 2 },
  extra_info: { audio_length: 900 },
  base_resp: { status_code: 0, status_msg: 'success' }
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
};

/** A ledger with all the room in the world, for tests that are not about the
 *  rate limit. */
const openLedger = () => new VoicePlayLedger(() => 0);

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE ASSIGNMENT — deterministic, stable, and derived from the identity the
//    agent already has on the floor.
// ─────────────────────────────────────────────────────────────────────────────
test('every fixed Office character has its own named voice', () => {
  const seen = new Map();
  for (const name of OFFICE_CAST) {
    const voice = CAST_VOICES[name];
    assert.ok(voice, `${name} has no voice in CAST_VOICES`);
    assert.equal(typeof voice, 'string');
    assert.ok(voice.trim().length > 0, `${name}'s voice id is blank`);
    // Two characters sharing a voice would make two visibly different avatars
    // indistinguishable by ear, which defeats the point of the feature.
    assert.ok(!seen.has(voice), `${name} shares ${voice} with ${seen.get(voice)}`);
    seen.set(voice, name);
  }
  // And nothing extra: an entry for a character the floor cannot render is dead
  // configuration that will drift.
  assert.deepEqual(Object.keys(CAST_VOICES).sort(), [...OFFICE_CAST].sort());
});

test('the same agent always resolves to the same voice', () => {
  const who = { agentId: 'dwight-mqp3l5wn', character: 'dwight' };
  const first = voiceIdFor(who);
  // Same call, a fresh object, and a thousand repeats: a voice is an identity,
  // so there is no place for randomness or for first-call memoisation.
  for (let i = 0; i < 1000; i++) {
    assert.equal(voiceIdFor({ agentId: who.agentId, character: who.character }), first);
  }
  assert.equal(first, CAST_VOICES.dwight);
});

test('two agents presenting as the same character sound the same', () => {
  // They are drawn from the same sprite recipe; sounding like different people
  // would contradict what the user is looking at.
  assert.equal(
    voiceIdFor({ agentId: 'jim-aaa', character: 'jim' }),
    voiceIdFor({ agentId: 'jim-bbb', character: 'jim' })
  );
  // …and different characters do not.
  assert.notEqual(
    voiceIdFor({ agentId: 'a', character: 'pam' }),
    voiceIdFor({ agentId: 'a', character: 'stanley' })
  );
});

test('the character key is matched case-insensitively', () => {
  assert.equal(voiceIdFor({ agentId: 'x', character: 'Dwight' }), CAST_VOICES.dwight);
  assert.equal(voiceIdFor({ agentId: 'x', character: '  ANGELA  ' }), CAST_VOICES.angela);
});

test('custom characters get a stable voice from the fallback pool', () => {
  const custom = 'custom:9f2c1d44-0b6e-4a71-9a2f-1f0e6c8b7a55';
  const voice = voiceIdFor({ agentId: 'weird-1', character: custom });
  assert.ok(FALLBACK_VOICES.includes(voice), `${voice} is not in the fallback pool`);
  // Stable across calls…
  assert.equal(voiceIdFor({ agentId: 'weird-1', character: custom }), voice);
  // …and keyed on the CHARACTER, so two agents wearing the same custom
  // character match each other exactly like two agents wearing the same Jim.
  assert.equal(voiceIdFor({ agentId: 'weird-2', character: custom }), voice);
});

test('an agent with no character at all still gets a stable voice', () => {
  const a = voiceIdFor({ agentId: 'nameless-1' });
  const b = voiceIdFor({ agentId: 'nameless-1', character: '' });
  assert.equal(a, b);
  assert.ok(FALLBACK_VOICES.includes(a));
  // Falling back to the agent id means two characterless agents are still
  // usually told apart.
  assert.equal(voiceIdFor({ agentId: 'nameless-1' }), a);
});

test('the hash is platform-independent and spread across the pool', () => {
  // FNV-1a over a fixed string must give the same number everywhere, or the same
  // agent would sound different on a colleague's machine.
  assert.equal(hashString('dwight'), hashString('dwight'));
  assert.equal(typeof hashString('x'), 'number');
  assert.ok(Number.isInteger(hashString('x')) && hashString('x') >= 0);
  // Over many synthetic custom characters, more than one voice is actually used —
  // a hash that collapsed onto a single bucket would be a silent bug.
  const used = new Set();
  for (let i = 0; i < 200; i++) used.add(voiceIdFor({ agentId: `a${i}`, character: `custom:${i}` }));
  assert.ok(used.size > 1, 'the fallback hash collapsed onto one voice');
});

test('an explicit per-agent override beats everything, including the cast', () => {
  const overrides = { 'dwight-1': 'English_Wiselady', 'weird-1': 'Calm_Woman' };
  assert.equal(voiceIdFor({ agentId: 'dwight-1', character: 'dwight' }, overrides), 'English_Wiselady');
  assert.equal(voiceIdFor({ agentId: 'weird-1', character: 'custom:zzz' }, overrides), 'Calm_Woman');
  // An agent with no pin is unaffected by other people's pins.
  assert.equal(voiceIdFor({ agentId: 'dwight-2', character: 'dwight' }, overrides), CAST_VOICES.dwight);
  // A junk pin (hand-edited config) is ignored, not forwarded upstream.
  for (const junk of [{ 'dwight-1': '' }, { 'dwight-1': '   ' }, { 'dwight-1': null }, {}]) {
    assert.equal(voiceIdFor({ agentId: 'dwight-1', character: 'dwight' }, junk), CAST_VOICES.dwight);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FLAG — off means nothing at all happens.
// ─────────────────────────────────────────────────────────────────────────────
test('with the flag off the gate refuses before it reads the key', () => {
  const ledger = openLedger();
  const req = { agentId: 'jim-1', character: 'jim', text: 'the machine is judging us' };
  for (const cfg of [
    { officeVoicesEnabled: false, minimaxApiKey: 'sk-secret' },
    { minimaxApiKey: 'sk-secret' },              // absent flag ⇒ off
    { officeVoicesEnabled: 'yes', minimaxApiKey: 'sk-secret' }, // only true is true
    {},
    null
  ]) {
    const plan = planSpeech(cfg, req, ledger);
    assert.equal(plan.ok, false);
    // The FIRST refusal, always: the order of the checks is the guarantee that a
    // disabled feature never touches the credential.
    assert.equal(plan.reason, 'disabled');
  }
  // And nothing was charged: a refusal must not consume the minute's allowance.
  assert.equal(ledger.count(), 0);
});

test('with the flag off no request can reach the endpoint', async () => {
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  try {
    const ledger = openLedger();
    // The production shape: the handler only dispatches when the gate says yes.
    for (let i = 0; i < 20; i++) {
      const plan = planSpeech(
        { officeVoicesEnabled: false, minimaxApiKey: 'sk-secret' },
        { agentId: 'jim-1', character: 'jim', text: 'line ' + i },
        ledger
      );
      if (plan.ok) {
        ledger.note();
        await synthesizeSpeech({ apiKey: 'sk-secret', endpoint: ep.endpoint, text: plan.text, voiceId: plan.voiceId });
      }
    }
    assert.equal(ep.hits.length, 0, 'a disabled feature must never reach the network');
  } finally { await ep.close(); }
});

test('the gate says yes only when everything is in place', () => {
  const plan = planSpeech(
    { officeVoicesEnabled: true, minimaxApiKey: 'sk-secret' },
    { agentId: 'dwight-1', character: 'dwight', text: 'fact: the coffee is older than you' },
    openLedger()
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.voiceId, CAST_VOICES.dwight);
  assert.equal(plan.text, 'fact: the coffee is older than you');
});

test('a malformed or empty line is refused without spending anything', () => {
  const cfg = { officeVoicesEnabled: true, minimaxApiKey: 'sk-secret' };
  const ledger = openLedger();
  assert.equal(planSpeech(cfg, { agentId: '', text: 'hi' }, ledger).reason, 'no-agent');
  assert.equal(planSpeech(cfg, { agentId: 'a', text: '' }, ledger).reason, 'nothing-to-say');
  assert.equal(planSpeech(cfg, { agentId: 'a', text: '   ' }, ledger).reason, 'nothing-to-say');
  assert.equal(planSpeech(cfg, { agentId: 'a', text: 42 }, ledger).reason, 'nothing-to-say');
  assert.equal(planSpeech(cfg, null, ledger).reason, 'no-agent');
  assert.equal(ledger.count(), 0);
});

test('speakable text is normalised and capped, never invented', () => {
  assert.equal(speakableText('  two   spaces\nand a newline '), 'two spaces and a newline');
  assert.equal(speakableText(''), null);
  assert.equal(speakableText(null), null);
  assert.equal(speakableText(undefined), null);
  const long = 'a'.repeat(MAX_SPEAK_CHARS * 3);
  assert.equal(speakableText(long).length, MAX_SPEAK_CHARS);
  // The content itself is passed through verbatim: audio that disagreed with the
  // bubble the user is reading would be worse than saying the line as written.
  assert.equal(speakableText('ok but why is it MY branch'), 'ok but why is it MY branch');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NO KEY — silent, and no request at all.
// ─────────────────────────────────────────────────────────────────────────────
test('voices on but no key is a silent refusal, not an error', () => {
  const ledger = openLedger();
  for (const key of [undefined, '', '   ']) {
    const plan = planSpeech(
      { officeVoicesEnabled: true, minimaxApiKey: key },
      { agentId: 'jim-1', character: 'jim', text: 'hey' },
      ledger
    );
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'no-key');
  }
  // Discovering there is no key costs nothing — the user pasting one a minute
  // later must find a full allowance.
  assert.equal(ledger.count(), 0);
});

test('the adapter refuses a keyless call before dispatching anything', async () => {
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  try {
    for (const apiKey of ['', '   ', undefined]) {
      const out = await synthesizeSpeech({
        apiKey, endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman'
      });
      assert.equal(out.ok, false);
      assert.equal(out.audio, undefined);
    }
    assert.equal(ep.hits.length, 0, 'a keyless request must never reach the network');
  } finally { await ep.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE HAPPY PATH — and the key staying where it belongs.
// ─────────────────────────────────────────────────────────────────────────────
test('a 200 yields decoded audio, and the key rides only the Authorization header', async () => {
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  try {
    const out = await synthesizeSpeech({
      apiKey: 'sk-secret-value', endpoint: ep.endpoint,
      text: 'the machine is judging us', voiceId: 'Deep_Voice_Man'
    });
    assert.equal(out.ok, true);
    assert.equal(out.mimeType, TTS_MIME_TYPE);
    assert.deepEqual(Array.from(out.audio), Array.from(CLIP_BYTES));

    const hit = ep.hits[0];
    assert.equal(hit.method, 'POST');
    assert.equal(hit.headers.authorization, 'Bearer sk-secret-value');
    const sent = JSON.parse(hit.body);
    assert.equal(sent.model, DEFAULT_MINIMAX_MODEL);
    assert.equal(sent.stream, false);
    assert.equal(sent.text, 'the machine is judging us');
    assert.equal(sent.voice_setting.voice_id, 'Deep_Voice_Man');
    // The key is nowhere in the body, and nowhere in what we hand back.
    assert.ok(!hit.body.includes('sk-secret-value'));
    assert.ok(!JSON.stringify({ ...out, audio: undefined }).includes('sk-secret-value'));
  } finally { await ep.close(); }
});

test('the configured model is sent verbatim', async () => {
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  try {
    await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, model: 'speech-2.6-hd',
      text: 'hi', voiceId: 'Calm_Woman'
    });
    assert.equal(JSON.parse(ep.hits[0].body).model, 'speech-2.6-hd');
  } finally { await ep.close(); }
});

test('a GroupId is appended as a query parameter when configured', async () => {
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  try {
    await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, groupId: 'grp-123',
      text: 'hi', voiceId: 'Calm_Woman'
    });
    assert.match(ep.hits[0].url, /GroupId=grp-123/);
  } finally { await ep.close(); }
});

test('the endpoint refuses anything that is not http(s)', () => {
  for (const bad of ['not a url', 'file:///etc/passwd', 'ftp://example.com']) {
    assert.equal(ttsUrl(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  // Empty falls back to the shipped global host rather than failing.
  assert.match(ttsUrl(''), /^https:\/\/api\.minimax\.io\/v1\/t2a_v2/);
  assert.match(ttsUrl(undefined), /^https:\/\/api\.minimax\.io\/v1\/t2a_v2/);
});

test('hex audio is decoded strictly — junk becomes silence, not noise', () => {
  assert.deepEqual(Array.from(decodeHexAudio(CLIP_HEX)), Array.from(CLIP_BYTES));
  for (const bad of ['', 'abc', 'zzzz', 'ff ff', null, 42, undefined, {}]) {
    assert.equal(decodeHexAudio(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DEGRADATION — every failure is silence, and none of them throw.
// ─────────────────────────────────────────────────────────────────────────────
test('a 500 is silence, not an exception', async () => {
  const ep = await fakeMinimax((_req, res) => {
    sendJson(res, 500, JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limit' } }));
  });
  try {
    const out = await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman'
    });
    assert.equal(out.ok, false);
    assert.equal(out.audio, undefined);
    // The provider's own sentence survives — it is the only debugging surface —
    // but it never leaves main.
    assert.match(out.error, /500/);
    assert.match(out.error, /rate limit/);
  } finally { await ep.close(); }
});

test('a MiniMax error inside a 200 is still silence', async () => {
  // The failure mode that a naive HTTP-status check would sail straight past:
  // an expired key, a retired voice id and an exhausted balance all arrive as
  // a perfectly healthy 200 with a non-zero base_resp.
  const ep = await fakeMinimax((_req, res) => {
    sendJson(res, 200, JSON.stringify({
      data: {},
      base_resp: { status_code: 1004, status_msg: 'invalid api key' }
    }));
  });
  try {
    const out = await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman'
    });
    assert.equal(out.ok, false);
    assert.equal(out.audio, undefined);
    assert.match(out.error, /1004/);
  } finally { await ep.close(); }
});

test('a 200 whose body is not JSON yields nothing rather than raw junk', async () => {
  const ep = await fakeMinimax((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>login required</html>');
  });
  try {
    const out = await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman'
    });
    assert.equal(out.ok, false);
    assert.equal(out.audio, undefined);
  } finally { await ep.close(); }
});

test('a 200 with no audio payload yields nothing', async () => {
  const ep = await fakeMinimax((_req, res) => {
    sendJson(res, 200, JSON.stringify({ data: { audio: '' }, base_resp: { status_code: 0 } }));
  });
  try {
    const out = await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman'
    });
    assert.equal(out.ok, false);
  } finally { await ep.close(); }
});

test('an unreachable endpoint degrades exactly like a 500', async () => {
  // Bind, learn the port, then close it: nothing is listening there any more.
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  const endpoint = ep.endpoint;
  await ep.close();
  const out = await synthesizeSpeech({ apiKey: 'k', endpoint, text: 'hello', voiceId: 'Calm_Woman' });
  assert.equal(out.ok, false);
  assert.equal(out.audio, undefined);
});

test('a hung endpoint is cut off at the timeout', async () => {
  const ep = await fakeMinimax(() => { /* accepts, then never answers */ });
  try {
    const t0 = Date.now();
    const out = await synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman', timeoutMs: 250
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /timed out|cancelled/);
    assert.ok(Date.now() - t0 < 4000, 'the timeout did not fire');
  } finally { await ep.close(); }
});

test('an abort cuts an in-flight clip instead of waiting it out', async () => {
  const ep = await fakeMinimax(() => { /* never answers */ });
  try {
    const controller = new AbortController();
    const t0 = Date.now();
    const running = synthesizeSpeech({
      apiKey: 'k', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman', signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    const out = await running;
    assert.equal(out.ok, false);
    // Quit / home change must not be held up by a clip nobody will hear.
    assert.ok(Date.now() - t0 < 5000, 'abort did not cut the request');
  } finally { await ep.close(); }
});

test('an error string never carries the key, even if the endpoint echoes it', async () => {
  const ep = await fakeMinimax((_req, res) => {
    // A hostile (or merely careless) endpoint quoting the Authorization header
    // back at us is exactly how a credential launders itself into a log.
    sendJson(res, 401, JSON.stringify({ base_resp: { status_msg: 'bad token sk-leaky-key' } }));
  });
  try {
    const out = await synthesizeSpeech({
      apiKey: 'sk-leaky-key', endpoint: ep.endpoint, text: 'hello', voiceId: 'Calm_Woman'
    });
    assert.equal(out.ok, false);
    assert.ok(!out.error.includes('sk-leaky-key'), `key leaked into: ${out.error}`);
    assert.match(out.error, /redacted/);
  } finally { await ep.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE RATE LIMIT — checked in MAIN, so no caller can spend the quota.
// ─────────────────────────────────────────────────────────────────────────────
test('the ledger counts a rolling minute and reopens as it slides', () => {
  const ledger = new VoicePlayLedger(() => 3);
  const t0 = 1_000_000_000;
  assert.equal(ledger.allows(t0), true);
  ledger.note(t0);
  ledger.note(t0 + 1000);
  assert.equal(ledger.allows(t0 + 2000), true);
  ledger.note(t0 + 2000);
  // Three in the window: the fourth is refused.
  assert.equal(ledger.count(t0 + 2000), 3);
  assert.equal(ledger.allows(t0 + 2000), false);
  // 59 seconds later the first is still inside the window…
  assert.equal(ledger.allows(t0 + 59_000), false);
  // …and a minute after it, only the other two count, so clips resume.
  assert.equal(ledger.count(t0 + 60_001), 2);
  assert.equal(ledger.allows(t0 + 60_001), true);
});

test('asking never consumes the allowance', () => {
  const ledger = new VoicePlayLedger(() => 1);
  for (let i = 0; i < 50; i++) assert.equal(ledger.allows(), true);
  assert.equal(ledger.count(), 0);
  ledger.note();
  assert.equal(ledger.allows(), false);
});

test('a limit of 0 (or a nonsense value) means unlimited', () => {
  for (const limit of [0, -5, NaN, undefined, 'lots']) {
    const ledger = new VoicePlayLedger(() => limit);
    for (let i = 0; i < 500; i++) ledger.note();
    assert.equal(ledger.allows(), true, `limit ${String(limit)} should be unlimited`);
  }
});

test('the limit is read live, so a settings change binds on the next clip', () => {
  let limit = 1;
  const ledger = new VoicePlayLedger(() => limit);
  ledger.note();
  assert.equal(ledger.allows(), false);
  limit = 5;   // the user raised it in Settings
  assert.equal(ledger.allows(), true, 'the limit was captured instead of read');
});

test('an exhausted minute stops clips reaching the endpoint at all', async () => {
  const ep = await fakeMinimax((_req, res) => { sendJson(res, 200, okBody()); });
  try {
    const ledger = new VoicePlayLedger(() => 2);
    const cfg = { officeVoicesEnabled: true, minimaxApiKey: 'sk-secret' };
    let spoken = 0;
    // The floor firing far faster than the ceiling allows — a six-line exchange
    // plus a buggy caller retrying it.
    for (let i = 0; i < 30; i++) {
      const plan = planSpeech(cfg, { agentId: 'jim-1', character: 'jim', text: `line ${i}` }, ledger);
      if (!plan.ok) {
        assert.equal(plan.reason, 'rate-limited');
        continue;
      }
      ledger.note();
      const out = await synthesizeSpeech({
        apiKey: 'sk-secret', endpoint: ep.endpoint, text: plan.text, voiceId: plan.voiceId
      });
      if (out.ok) spoken++;
    }
    assert.equal(spoken, 2);
    assert.equal(ep.hits.length, 2, 'the ceiling did not stop the requests going out');
  } finally { await ep.close(); }
});

test('the shipped default lets a whole exchange through but stops a runaway', () => {
  // A café exchange is 2–6 beats (officeChat.ts): the default must never cut one
  // off half-spoken…
  assert.ok(DEFAULT_VOICE_PLAYS_PER_MINUTE >= 6);
  // …and must still be a ceiling rather than a formality.
  assert.ok(DEFAULT_VOICE_PLAYS_PER_MINUTE <= 30);
});

test('reset() forgets the window', () => {
  const ledger = new VoicePlayLedger(() => 1);
  ledger.note();
  assert.equal(ledger.allows(), false);
  ledger.reset();
  assert.equal(ledger.allows(), true);
  assert.equal(ledger.count(), 0);
});
