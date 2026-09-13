'use strict';

// The OpenAI-compatible chatter route (src/main/chatterOpenAI.ts) and the way
// BrewSlot (src/main/brewSlot.ts) drives it.
//
// WHY THIS ROUTE EXISTS: the chatter used to have exactly one engine — a hidden
// `claude` CLI session, i.e. the SAME subscription the agents doing real work
// draw on. A talkative office therefore took quota from the agents resolving
// real incidents. This file holds the second route to the promise that makes it
// worth having:
//
//   1. IT REPLACES THE ENGINE, NOT THE GUARANTEES. With the provider set to
//      'openai-compatible', `runHiddenClaude` is never called, and the brew is
//      still: one in flight, one hard timeout, exactly ONE retry, abortable.
//   2. IT NEVER INVENTS. A 500, a timeout, an unreachable host or a missing key
//      yields NOTHING — the caller takes its existing no-line path. No
//      placeholder text ever reaches the floor, and no network failure escapes
//      as a rejection or wedges the single slot.
//   3. THE BUDGET BINDS. A rolling-hour token ceiling stops brewing on both
//      routes once it is spent, and re-opens as the spend ages out.
//   4. THE KEY STAYS PUT. It appears in the Authorization header and nowhere
//      else — not in a result, not in an error string.
//
// NOTHING here touches a real service: every request goes to a throwaway
// `node:http` server bound to 127.0.0.1 on an ephemeral port.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const hidden = loadTs('src/main/hiddenClaude.ts');
const {
  chatterHttpComplete,
  chatCompletionsUrl,
  estimateTokens,
  ChatterTokenLedger,
  DEFAULT_CHATTER_TOKEN_BUDGET_PER_HOUR
} = loadTs('src/main/chatterOpenAI.ts');
const { BrewSlot } = loadTs('src/main/brewSlot.ts');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-http-'));

/** A fake OpenAI-compatible endpoint. `handler(req, res, body)` decides what it
 *  does; `server.hits` records every request it saw (headers included, so a test
 *  can assert on the Authorization header). */
async function fakeEndpoint(handler) {
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
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** The happy-path body a well-behaved endpoint returns. */
const okBody = (content, usage) => JSON.stringify({
  choices: [{ message: { role: 'assistant', content } }],
  ...(usage ? { usage } : {})
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
};

/** A slot pointed at `baseUrl`, plus a stub hidden-Claude that SCREAMS if the
 *  HTTP route ever falls back to it. */
function httpSlot({ baseUrl, apiKey = 'sk-test-key', budget = 0, home = tmpHome() }) {
  const hiddenCalls = [];
  hidden.runHiddenClaude = async (prompt, o) => {
    hiddenCalls.push({ prompt, ...o });
    return { ok: true, text: '["hidden route ran"]' };
  };
  const slot = new BrewSlot({
    getHome: () => home,
    getCommand: () => 'claude',
    getProvider: () => 'openai-compatible',
    getEndpoint: () => ({ baseUrl, apiKey }),
    getTokenBudgetPerHour: () => budget
  });
  return { slot, hiddenCalls, home };
}

/** A brew request with no budget friction, so each test drives exactly one. */
const brewReq = (over = {}) => ({
  lane: 'cafe',
  limits: { minGapMs: 0, maxPerHour: 100, keyCooldownMs: 0 },
  key: 'a|b',
  prompt: 'write one dry line about the coffee machine',
  model: 'deepseek-chat',
  parse: (text) => (text && text.trim() ? text.trim() : null),
  ...over
});

// ─────────────────────────────────────────────────────────────────────────────
// URL composition — the field a user pastes is not a URL builder.
// ─────────────────────────────────────────────────────────────────────────────
test('base URL accepts a root, a versioned path, or a full completions URL', () => {
  assert.equal(chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(
    chatCompletionsUrl('http://localhost:1234/v1/chat/completions'),
    'http://localhost:1234/v1/chat/completions'
  );
});

test('base URL refuses anything that is not http(s)', () => {
  // A settings field that accepted file:// would be a local read primitive.
  for (const bad of ['', '   ', 'not a url', 'file:///etc/passwd', 'ftp://example.com']) {
    assert.equal(chatCompletionsUrl(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. OK response.
// ─────────────────────────────────────────────────────────────────────────────
test('a 200 returns the model text, and charges the usage the endpoint reported', async () => {
  const ep = await fakeEndpoint((_req, res) => {
    sendJson(res, 200, okBody('["the machine is judging us", "it has earned the right"]',
      { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 }));
  });
  try {
    const out = await chatterHttpComplete({
      baseUrl: ep.baseUrl, apiKey: 'sk-secret-value', model: 'deepseek-chat',
      prompt: 'write two dry lines', timeoutMs: 5000
    });
    assert.equal(out.ok, true);
    assert.match(out.text, /judging us/);
    // Real usage, not the estimate.
    assert.equal(out.tokens, 340);
    assert.equal(out.estimated, false);

    // The request is shaped the way every OpenAI-compatible server expects, and
    // the key rides ONLY the Authorization header.
    const hit = ep.hits[0];
    assert.equal(hit.method, 'POST');
    assert.equal(hit.url, '/v1/chat/completions');
    assert.equal(hit.headers.authorization, 'Bearer sk-secret-value');
    const sent = JSON.parse(hit.body);
    assert.equal(sent.model, 'deepseek-chat');
    assert.equal(sent.stream, false);
    assert.equal(sent.messages[0].content, 'write two dry lines');
    // The key is nowhere in the body, and nowhere in what we hand back.
    assert.ok(!hit.body.includes('sk-secret-value'));
    assert.ok(!JSON.stringify(out).includes('sk-secret-value'));
  } finally { await ep.close(); }
});

test('a 200 with no usage block falls back to the ~4-chars-per-token estimate', async () => {
  const reply = '["fine", "fine."]';
  const ep = await fakeEndpoint((_req, res) => { sendJson(res, 200, okBody(reply)); });
  try {
    const prompt = 'x'.repeat(400);
    const out = await chatterHttpComplete({
      baseUrl: ep.baseUrl, apiKey: 'k', model: 'm', prompt, timeoutMs: 5000
    });
    assert.equal(out.ok, true);
    assert.equal(out.estimated, true);
    assert.equal(out.tokens, estimateTokens(prompt) + estimateTokens(reply));
  } finally { await ep.close(); }
});

test('the slot routes a brew over HTTP and never touches the hidden Claude CLI', async () => {
  const ep = await fakeEndpoint((_req, res) => { sendJson(res, 200, okBody('a dry line')); });
  const { slot, hiddenCalls } = httpSlot({ baseUrl: ep.baseUrl });
  try {
    const got = await slot.run(brewReq());
    assert.equal(got, 'a dry line');
    assert.equal(ep.hits.length, 1);
    // THE POINT OF THE WHOLE FEATURE: the user's working Claude quota is untouched.
    assert.equal(hiddenCalls.length, 0);
    // The slot is free again the moment the brew settles.
    assert.equal(slot.busy, false);
  } finally { await ep.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A 500 — degrade to nothing, after exactly ONE retry.
// ─────────────────────────────────────────────────────────────────────────────
test('a 500 is a failure, not a line, and never throws', async () => {
  const ep = await fakeEndpoint((_req, res) => {
    sendJson(res, 500, JSON.stringify({ error: { message: 'upstream exploded' } }));
  });
  try {
    const out = await chatterHttpComplete({
      baseUrl: ep.baseUrl, apiKey: 'k', model: 'm', prompt: 'hello', timeoutMs: 5000
    });
    assert.equal(out.ok, false);
    assert.equal(out.text, undefined);
    // The provider's own sentence is kept — it is the only debugging surface.
    assert.match(out.error, /500/);
    assert.match(out.error, /upstream exploded/);
    // The request went out, so the prompt is charged even though we got nothing.
    assert.equal(out.tokens, estimateTokens('hello'));
  } finally { await ep.close(); }
});

test('a failing endpoint costs the slot exactly two attempts, then yields nothing', async () => {
  const ep = await fakeEndpoint((_req, res) => { sendJson(res, 500, '{}'); });
  const { slot, hiddenCalls } = httpSlot({ baseUrl: ep.baseUrl });
  try {
    const got = await slot.run(brewReq());
    // No line, no invention, no exception — the caller plays canned dialogue.
    assert.equal(got, null);
    // ONE attempt plus the ONE documented retry. Not three, not a storm.
    assert.equal(ep.hits.length, 2);
    // And it never quietly fell back to the subscription we are trying to spare.
    assert.equal(hiddenCalls.length, 0);
    assert.equal(slot.busy, false);
  } finally { await ep.close(); }
});

test('an unreachable endpoint degrades the same way a 500 does', async () => {
  // Bind, learn the port, then close it: nothing is listening there any more.
  const ep = await fakeEndpoint((_req, res) => { sendJson(res, 200, okBody('never')); });
  const baseUrl = ep.baseUrl;
  await ep.close();
  const { slot } = httpSlot({ baseUrl });
  const got = await slot.run(brewReq());
  assert.equal(got, null);
  assert.equal(slot.busy, false);
});

test('a 200 carrying a body that is not JSON yields nothing rather than raw junk', async () => {
  const ep = await fakeEndpoint((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>login required</html>');
  });
  try {
    const out = await chatterHttpComplete({
      baseUrl: ep.baseUrl, apiKey: 'k', model: 'm', prompt: 'hello', timeoutMs: 5000
    });
    assert.equal(out.ok, false);
    assert.equal(out.text, undefined);
  } finally { await ep.close(); }
});

test('a body larger than the ceiling is refused even with no content-length', async () => {
  // THE HOLE THIS CLOSES: the size check used to read `content-length`, which a
  // chunked response simply does not send — so an endpoint could skip the
  // ceiling by declaring nothing and stream unbounded bytes into the MAIN
  // process. The cap is now on what arrives, and the socket is cut mid-body.
  // The endpoint NEVER ends the body — it just keeps writing. So the only way
  // this test can report "too large" is if the cap fired on the bytes as they
  // arrived; a cap that waited for the body to finish would hit the 10s timeout
  // instead, and a cap that trusted content-length would never fire at all.
  let live = true;
  const ep = await fakeEndpoint((_req, res) => {
    const stop = () => { live = false; };
    res.on('error', stop);   // we hang up on it on purpose
    res.on('close', stop);
    res.writeHead(200, { 'Content-Type': 'application/json' });  // chunked: no length
    const chunk = 'x'.repeat(64 * 1024);
    let written = 0;
    const pump = () => {
      while (live && written < 64 * 1024 * 1024) {   // runaway guard, never reached
        written += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
    };
    pump();
  });
  try {
    const t0 = Date.now();
    const out = await chatterHttpComplete({
      baseUrl: ep.baseUrl, apiKey: 'k', model: 'm', prompt: 'hello', timeoutMs: 10_000
    });
    assert.equal(out.ok, false);
    assert.equal(out.text, undefined);
    assert.match(out.error, /too large/, 'refused for SIZE, not by falling back to the timeout');
    assert.ok(Date.now() - t0 < 9000, 'the refusal must not wait out the request timeout');
    // Charged like any other dispatched-but-useless request, never as free.
    assert.equal(out.tokens, estimateTokens('hello'));
  } finally { live = false; await ep.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Timeout — a hung endpoint must not hold the slot.
// ─────────────────────────────────────────────────────────────────────────────
test('a hung endpoint is cut off at the timeout and reports no line', async () => {
  // Accepts the request and then simply never answers.
  const ep = await fakeEndpoint(() => { /* deliberately silent */ });
  try {
    const t0 = Date.now();
    const out = await chatterHttpComplete({
      baseUrl: ep.baseUrl, apiKey: 'k', model: 'm', prompt: 'hello', timeoutMs: 250
    });
    const elapsed = Date.now() - t0;
    assert.equal(out.ok, false);
    assert.match(out.error, /timed out|cancelled/);
    // Cut off at OUR ceiling, not left to whatever the socket would have done.
    assert.ok(elapsed < 4000, `took ${elapsed}ms — the timeout did not fire`);
  } finally { await ep.close(); }
});

test('stop() aborts an in-flight HTTP brew instead of waiting it out', async () => {
  const ep = await fakeEndpoint(() => { /* never answers */ });
  const { slot } = httpSlot({ baseUrl: ep.baseUrl });
  try {
    const t0 = Date.now();
    const running = slot.run(brewReq());
    // App quit / home change while the request is open.
    setTimeout(() => slot.stop(), 50);
    const got = await running;
    const elapsed = Date.now() - t0;
    assert.equal(got, null);
    // The brew timeout is 25s and the retry delay 1.5s; aborting must beat both,
    // which is the guarantee that a brew never outlives the process.
    assert.ok(elapsed < 5000, `took ${elapsed}ms — stop() did not cut the request`);
    assert.equal(slot.busy, false);
  } finally { await ep.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. No key — silent, and no request at all.
// ─────────────────────────────────────────────────────────────────────────────
test('with no API key the adapter refuses before dispatching anything', async () => {
  const ep = await fakeEndpoint((_req, res) => { sendJson(res, 200, okBody('should never run')); });
  try {
    for (const apiKey of ['', '   ']) {
      const out = await chatterHttpComplete({
        baseUrl: ep.baseUrl, apiKey, model: 'm', prompt: 'hello', timeoutMs: 5000
      });
      assert.equal(out.ok, false);
      assert.equal(out.text, undefined);
      // Nothing dispatched ⇒ nothing charged.
      assert.equal(out.tokens, 0);
    }
    assert.equal(ep.hits.length, 0, 'a keyless request must never reach the network');
  } finally { await ep.close(); }
});

test('an unconfigured endpoint makes the slot refuse the brew outright', async () => {
  const ep = await fakeEndpoint((_req, res) => { sendJson(res, 200, okBody('should never run')); });
  try {
    for (const endpoint of [{ baseUrl: ep.baseUrl, apiKey: '' }, { baseUrl: '', apiKey: 'k' }, {}]) {
      const home = tmpHome();
      const hiddenCalls = [];
      hidden.runHiddenClaude = async (prompt, o) => { hiddenCalls.push({ prompt, ...o }); return { ok: true, text: 'nope' }; };
      const slot = new BrewSlot({
        getHome: () => home,
        getCommand: () => 'claude',
        getProvider: () => 'openai-compatible',
        getEndpoint: () => endpoint
      });
      const req = brewReq();
      // Refused by the read-only pre-check, so a director asking "may I?" never
      // even builds a prompt…
      assert.equal(slot.allows(req.lane, req.limits, req.key), false);
      // …and the lane's hourly budget is NOT spent finding that out.
      assert.equal(await slot.run(req), null);
      assert.equal(hiddenCalls.length, 0, 'must not silently fall back to the Claude route');
    }
    assert.equal(ep.hits.length, 0);
  } finally { await ep.close(); }
});

test('the default provider is still the hidden Claude session', async () => {
  // An install that never opened the new setting must behave exactly as before.
  const home = tmpHome();
  const hiddenCalls = [];
  hidden.runHiddenClaude = async (prompt, o) => { hiddenCalls.push({ prompt, ...o }); return { ok: true, text: 'canned-by-claude' }; };
  const slot = new BrewSlot({ getHome: () => home, getCommand: () => 'claude' });
  assert.equal(await slot.run(brewReq()), 'canned-by-claude');
  assert.equal(hiddenCalls.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The hourly token budget.
// ─────────────────────────────────────────────────────────────────────────────
test('the ledger counts a rolling hour and reopens as spend ages out', () => {
  const ledger = new ChatterTokenLedger(() => 1000);
  const t0 = 1_000_000_000;
  ledger.note(600, t0);
  assert.equal(ledger.spent(t0), 600);
  assert.equal(ledger.allows(t0), true);
  ledger.note(500, t0 + 1000);
  // Overshoot by at most one brew is the documented shape — what matters is that
  // the NEXT brew is refused.
  assert.equal(ledger.allows(t0 + 2000), false);
  // 59 minutes later the first charge is still inside the window…
  assert.equal(ledger.allows(t0 + 59 * 60_000), false);
  // …and an hour after it, only the second charge counts, so brewing resumes.
  assert.equal(ledger.spent(t0 + 60 * 60_000 + 1), 500);
  assert.equal(ledger.allows(t0 + 60 * 60_000 + 1), true);
});

test('a budget of 0 (or a nonsense value) means unlimited', () => {
  for (const limit of [0, -5, NaN, undefined]) {
    const ledger = new ChatterTokenLedger(() => limit);
    ledger.note(10_000_000);
    assert.equal(ledger.allows(), true, `limit ${String(limit)} should be unlimited`);
    assert.equal(ledger.remaining(), Infinity);
  }
});

test('an exhausted budget stops brewing — no request, on any lane', async () => {
  const ep = await fakeEndpoint((_req, res) => {
    sendJson(res, 200, okBody('a line', { total_tokens: 500 }));
  });
  // A ceiling one brew wide: the first brew fits, the second is refused.
  const { slot, hiddenCalls } = httpSlot({ baseUrl: ep.baseUrl, budget: 400 });
  try {
    const req = brewReq();
    assert.equal(slot.allows(req.lane, req.limits, req.key), true);
    assert.equal(await slot.run(req), 'a line');
    assert.equal(ep.hits.length, 1);
    assert.equal(slot.tokensSpentThisHour, 500);

    // Budget gone. The read-only pre-check says so, and `run` honours it — the
    // office simply plays canned lines until the window reopens.
    assert.equal(slot.allows(req.lane, req.limits, req.key), false);
    assert.equal(await slot.run(req), null);
    // The OTHER lane is stopped too: the ceiling is the chatter's, not a lane's.
    const other = { ...req, lane: 'voice', key: 'agent-1' };
    assert.equal(slot.allows(other.lane, other.limits, other.key), false);
    assert.equal(await slot.run(other), null);

    assert.equal(ep.hits.length, 1, 'no further request may leave once the budget is spent');
    assert.equal(hiddenCalls.length, 0, 'and it must not divert to the Claude subscription either');
  } finally { await ep.close(); }
});

test('the hidden-Claude route is charged against the same budget, by estimate', async () => {
  const home = tmpHome();
  const reply = '["short", "lines"]';
  const prompt = 'y'.repeat(200);
  hidden.runHiddenClaude = async () => ({ ok: true, text: reply });
  const slot = new BrewSlot({
    getHome: () => home,
    getCommand: () => 'claude',
    getTokenBudgetPerHour: () => 40
  });
  const req = brewReq({ prompt });
  assert.equal(await slot.run(req), reply);
  // The CLI reports no usage at all, so the charge is ceil(chars/4) over both
  // halves — documented in chatterOpenAI.estimateTokens.
  assert.equal(slot.tokensSpentThisHour, estimateTokens(prompt) + estimateTokens(reply));
  assert.equal(slot.allows(req.lane, req.limits, req.key), false);
});

test('the shipped default budget is generous enough never to bind in normal use', () => {
  // The lanes allow at most 8 café + 6 aside brews an hour; the default must sit
  // comfortably above that so the ceiling is a runaway guard, not a rate limit.
  assert.ok(DEFAULT_CHATTER_TOKEN_BUDGET_PER_HOUR >= 14 * 900);
});
