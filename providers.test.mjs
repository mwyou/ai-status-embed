import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStatusServer } from './server.mjs';
import { GEMINI_STATUS_URL, GEMINI_INCIDENTS_RPC } from './gemini.mjs';
import { KIMI_STATUS_URL, KIMI_DATA_ROOT } from './kimi.mjs';
import { DEEPSEEK_OFFICIAL_URL } from './deepseek.mjs';

/**
 * SYNTHETIC FIXTURES ONLY.
 *
 * Every id, name, uptime, timestamp and markup token below is invented for these
 * integration tests. Nothing is copied from a live official payload. The markup mimics
 * the official page shapes closely enough to exercise server.mjs end to end.
 *
 * These tests target the consolidated server: one HTTP surface for all five providers,
 * one cache per provider, and adapters that only ever talk to fixed official URLs. The
 * adapter suites (gemini/deepseek/kimi .test.mjs) already own unit-level parsing, so this
 * file stays at the HTTP boundary and deliberately does not import them (importing a
 * *.test.mjs file would re-register its tests inside this run).
 *
 * The injected fetchFn is the server's own upstream seam: createStatusServer calls it as
 * fetchFn(url, init), and init carries the fixed method/body/headers a URL needs.
 */

const OPENAI_SUMMARY_URL = 'https://status.openai.com/api/v2/summary.json';
const CLAUDE_SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json';
const KIMI_SUMMARY_URL = KIMI_DATA_ROOT + '/api/v2/summary.json';

// ---------------------------------------------------------------------------
// Shared HTTP fixture
// ---------------------------------------------------------------------------

async function fixture(t, options) {
  const server = createStatusServer({ historyEnabled: false, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path, init) => fetch(base + path, init);
}

const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const text = body => new Response(String(body), { headers: { 'content-type': 'text/html' } });

// The server's text/HTML upstream calls identify themselves with accept: text/html.
const isTextRequest = init => String(init?.headers?.accept || '') === 'text/html';

// ---------------------------------------------------------------------------
// OpenAI / Claude synthetic summaries
// ---------------------------------------------------------------------------

const statuspageSummary = (indicator = 'none', componentName = 'API') => ({
  page: { updated_at: '2026-10-13T00:00:00Z' },
  status: { indicator, description: indicator === 'none' ? 'All Systems Operational' : 'Partial System Degradation' },
  components: [{ id: 'api', name: componentName, status: 'operational' }],
  incidents: []
});

// ---------------------------------------------------------------------------
// Kimi synthetic summary + uptime showcase
// ---------------------------------------------------------------------------

const kimiSummaryFixture = () => ({
  page: { id: '10y9y5wx5xh3', url: KIMI_STATUS_URL, updated_at: '2026-10-13T00:00:00Z' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    { id: 'kimi00000000', name: 'Kimi', group: true, status: 'operational' },
    { id: 'api000000000', name: 'API Service', group_id: 'kimi00000000', status: 'operational' }
  ],
  incidents: []
});

const kimiShowcaseFixture = () => ({
  components: { api000000000: '<svg><rect class="uptime-day day-0" fill="#1e8542"/></svg>' },
  values: [{ component: 'api000000000', ninety: 99.94 }],
  timelines: { api000000000: { days: [{ date: '2026-10-13', related_events: [] }] } }
});

const KIMI_SHOWCASE_URL = KIMI_DATA_ROOT + '/uptime_showcase?components=api000000000';

// ---------------------------------------------------------------------------
// Gemini synthetic incident feed + public configuration
// ---------------------------------------------------------------------------

const geminiUpdate = (state, seconds, body = 'Official update') => [state, 'Official display date', [String(seconds)], body];
const geminiIncident = () => ['synth-incident', 'Synthetic incident', 1, [geminiUpdate(1, 1791800000), geminiUpdate(3, 1791803600)], 1, [1, 3]];
const geminiFeed = (...incidents) => [[incidents]];
const GEMINI_PUBLIC_KEY = 'AIza' + 'x'.repeat(35);
const geminiPage = () => '<html>Public client configuration ' + GEMINI_PUBLIC_KEY + '</html>';

// ---------------------------------------------------------------------------
// DeepSeek synthetic SSR markup (Flashduty/Next.js shape)
// ---------------------------------------------------------------------------

const dsBars = (count, fill) => Array.from({ length: count },
  (_, i) => `<rect x="${i * 6.5}" y="0" width="5" height="16" fill="${fill}"></rect>`).join('');

const dsRow = ({ name, dot = 'bg-green-500', uptime = '99.00', dayCount = 90, fill = '#22c55e' }) =>
  '<div class="p-4"><div class="flex items-center justify-between gap-2">'
  + '<div class="flex items-center gap-2 min-w-0">'
  + `<div class="flex items-center justify-center rounded-full shrink-0 ${dot} h-4 w-4"></div>`
  + `<span class="font-medium text-sm">${name}</span></div>`
  + `<div class="text-sm shrink-0 whitespace-nowrap">${uptime}% uptime</div></div>`
  + `<div class="hidden sm:block"><svg width="100%" height="16" class="mt-3">${dsBars(dayCount, fill)}</svg></div></div>`;

const dsOverall = ({ dot = 'bg-green-500', title = 'Everything is running smoothly', description = 'All systems are operating as expected.' } = {}) =>
  '<div hidden="" id="S:5"><div class="space-y-2"><div class="rounded-xl border p-1"><div class="p-4 pt-3">'
  + `<h2 class="font-medium"><div class="flex items-center justify-center rounded-full shrink-0 ${dot} h-4 w-4"></div>${title}</h2>`
  + (description ? `<p class="text-sm mt-1">${description}</p>` : '')
  + '</div></div></div></div>';

const dsSystem = ({ groups, rangeLabel = 'Jul 2026 - Oct 2026' }) =>
  '<div hidden="" id="S:6"><div class="rounded-xl overflow-hidden"><div class="p-4 py-3.5"><h2 class="font-medium">System status</h2>'
  + `<div><span class="min-w-[150px] text-center">${rangeLabel}</span></div></div>`
  + `<div class="divide-y bg-background">${groups.join('')}</div></div></div>`;

const dsFlight = (activeChanges = []) => {
  const payload = JSON.stringify({
    page: { components: [{ component_id: 'synth-comp-1', name: 'Chat Service' }], sections: [] },
    active_changes: activeChanges
  });
  return `<script>self.__next_f.push([1,${JSON.stringify('"initialData":' + payload)}])</script>`;
};

const deepseekMarkup = ({ rangeLabel = 'Jul 2026 - Oct 2026', activeChanges = [] } = {}) =>
  '<!doctype html><html><body>'
  + dsOverall()
  + dsSystem({ groups: [dsRow({ name: 'Chat Service' })], rangeLabel })
  + dsFlight(activeChanges)
  + '</body></html>';

// ===========================================================================
// Page routes and aliases
// ===========================================================================

const HEADINGS = { openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', kimi: 'Kimi' };

for (const provider of ['gemini', 'deepseek', 'kimi']) {
  test(`${provider} is served as .html and as a bare alias without being switchable`, async t => {
    const get = await fixture(t, { fetchFn: async () => json(statuspageSummary()) });
    for (const path of [`/${provider}`, `/${provider}.html`, `/${provider}.html?provider=openai&token=secret`]) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      const body = await response.text();
      assert.match(body, new RegExp(`<h1>${HEADINGS[provider]}</h1>`));
      assert.doesNotMatch(body, /<h1>OpenAI</);
    }
    const head = await get(`/${provider}`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  });
}

test('legacy ?provider links redirect for every provider and carry only a valid theme', async t => {
  const get = await fixture(t, { fetchFn: async () => json(statuspageSummary()) });
  for (const provider of ['openai', 'claude', 'gemini', 'deepseek', 'kimi']) {
    for (const path of ['/', '/index.html']) {
      for (const theme of ['light', 'dark', 'invalid', 'dark%3Btoken%3Dsecret']) {
        const response = await get(`${path}?provider=${provider}&theme=${theme}&token=secret&redirect=https://example.com`, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'),
          `/${provider}.html` + (['light', 'dark'].includes(theme) ? `?theme=${theme}` : ''));
      }
    }
  }
  // An unknown provider never becomes a redirect.
  const unknown = await get('/?provider=glm', { redirect: 'manual' });
  assert.equal(unknown.status, 200); assert.equal(unknown.headers.get('location'), null);
});

// ===========================================================================
// Upstream request discipline
// ===========================================================================

test('client tokens, Authorization, cookies and arbitrary URLs never reach an upstream', async t => {
  const calls = [];
  const get = await fixture(t, { historyEnabled: true, fetchFn: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return String(url) === GEMINI_STATUS_URL ? text(geminiPage()) : json(geminiFeed(geminiIncident()));
  } });
  const response = await get('/api/status/gemini?token=private&access_token=private&url=https://evil.example/steal', {
    headers: { authorization: 'Bearer private', cookie: 'session=private', 'x-forwarded-host': 'evil.example' }
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /private|evil\.example|Bearer/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok([GEMINI_STATUS_URL, GEMINI_INCIDENTS_RPC].includes(call.url), `unexpected upstream ${call.url}`);
    for (const name of Object.keys(call.init.headers || {})) {
      assert.doesNotMatch(name, /authorization|cookie|token|x-forwarded/i, `client header leaked: ${name}`);
    }
  }
});

test('OpenAI and Claude read their fixed official summary endpoints, ignoring client queries', async t => {
  const seen = [];
  const get = await fixture(t, { fetchFn: async url => { seen.push(String(url)); return json(statuspageSummary('none', 'API')); } });
  const openai = await (await get('/api/status/openai?redirect=https://evil.example')).json();
  const claude = await (await get('/api/status/claude?url=https://evil.example')).json();
  assert.deepEqual(seen, [OPENAI_SUMMARY_URL, CLAUDE_SUMMARY_URL]);
  assert.equal(openai.provider, 'openai'); assert.equal(claude.provider, 'claude');
  assert.equal(openai.officialUrl, 'https://status.openai.com');
  assert.equal(claude.officialUrl, 'https://status.claude.com');
});

// ===========================================================================
// Per-provider cache isolation, coalescing, cold failure, stale recovery
// ===========================================================================

test('each provider owns an isolated cache and concurrent fans-in are coalesced per provider', async t => {
  let openai = 0, claude = 0;
  const get = await fixture(t, { fetchFn: async url => {
    await new Promise(r => setTimeout(r, 10));
    if (String(url) === OPENAI_SUMMARY_URL) { openai++; return json(statuspageSummary('none', 'OpenAI API')); }
    if (String(url) === CLAUDE_SUMMARY_URL) { claude++; return json(statuspageSummary('minor', 'Claude API')); }
    throw new Error('unexpected ' + url);
  } });
  const [o1, c1, o2, c2] = await Promise.all([
    get('/api/status/openai'), get('/api/status/claude'), get('/api/status/openai'), get('/api/status/claude')
  ]);
  assert.equal(openai, 1); assert.equal(claude, 1, 'one provider cache must not serve another provider');
  assert.equal((await o1.json()).status.indicator, 'none');
  assert.equal((await c1.json()).provider, 'claude');
  assert.equal((await o2.json()).provider, 'openai');
  assert.equal((await c2.json()).status.indicator, 'minor');
});

test('a cold upstream failure is 502 with no synthetic health and its retry is throttled', async t => {
  let calls = 0;
  const get = await fixture(t, { historyEnabled: true, fetchFn: async () => { calls++; throw new Error('offline'); } });
  const response = await get('/api/status/gemini');
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.equal(data.provider, 'gemini'); assert.equal(data.stale, true);
  assert.equal(data.fetchedAt, null); assert.equal(data.status, undefined);
  assert.doesNotMatch(JSON.stringify(data), /offline/);
  assert.equal((await get('/api/status/gemini')).status, 502);
  assert.equal(calls, 1, 'failures are throttled by retryMs');
});

test('a stale refresh keeps the original time plus a warning and recovers on retry', async t => {
  let clock = 1800000000000, fail = false, calls = 0;
  const get = await fixture(t, { historyEnabled: true, now: () => clock, fetchFn: async () => {
    calls++;
    if (fail) throw new Error('secret upstream detail');
    return text(deepseekMarkup());
  } });
  const first = await (await get('/api/status/deepseek')).json();
  assert.equal(first.stale, false); assert.ok(first.fetchedAt);
  clock += 61000; fail = true;
  const failed = await (await get('/api/status/deepseek')).json();
  assert.equal(failed.stale, true);
  assert.equal(failed.fetchedAt, first.fetchedAt, 'the last successful fetch time is preserved');
  assert.match(failed.error, /Showing the last successfully fetched official data/);
  assert.doesNotMatch(JSON.stringify(failed), /secret upstream detail/);
  assert.equal(calls, 2, 'the failed attempt was not retried immediately');
  clock += 15001; fail = false;
  const recovered = await (await get('/api/status/deepseek')).json();
  assert.equal(recovered.stale, false); assert.equal(recovered.error, null);
  assert.notEqual(recovered.fetchedAt, first.fetchedAt);
});

// ===========================================================================
// Kimi: summary stays fresh when history fails; history is never estimated
// ===========================================================================

test('Kimi history failure does not disturb the fresh summary and estimates nothing', async t => {
  const get = await fixture(t, { historyEnabled: true, fetchFn: async url => {
    if (String(url) === KIMI_SUMMARY_URL) return json(kimiSummaryFixture());
    throw new Error('Official history unavailable');
  } });
  const response = await get('/api/status/kimi');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.stale, false); assert.ok(data.fetchedAt);
  assert.equal(data.components.length, 1);
  assert.equal(data.history.available, false);
  assert.match(data.history.error, /No uptime values or history bars have been estimated/);
  assert.equal(data.history.rows, undefined);
  assert.doesNotMatch(JSON.stringify(data), /[\u3400-\u9fff]/);
});

test('Kimi history reads the fixed official showcase once and keeps published values verbatim', async t => {
  const seen = [];
  const get = await fixture(t, { historyEnabled: true, fetchFn: async url => {
    seen.push(String(url));
    return String(url) === KIMI_SUMMARY_URL ? json(kimiSummaryFixture()) : json(kimiShowcaseFixture());
  } });
  const data = await (await get('/api/status/kimi')).json();
  assert.deepEqual(seen, [KIMI_SUMMARY_URL, KIMI_SHOWCASE_URL]);
  assert.equal(data.history.available, true);
  assert.equal(data.history.sourceUrl, KIMI_STATUS_URL);
  const rows = data.history.rows.filter(row => row.components?.length).flatMap(row => row.components);
  assert.equal(rows[0].uptime, '99.94', 'published percentage is kept as-is, not recalculated');
  assert.deepEqual(rows[0].days.map(day => day.state), ['operational']);
});

// ===========================================================================
// DeepSeek: one HTML fetch feeds summary + history; history drift never spoils summary
// ===========================================================================

test('DeepSeek reads the official SSR markup exactly once for summary and history', async t => {
  let calls = 0;
  const get = await fixture(t, { historyEnabled: true, fetchFn: async url => {
    assert.equal(String(url), DEEPSEEK_OFFICIAL_URL);
    calls++;
    return text(deepseekMarkup());
  } });
  const data = await (await get('/api/status/deepseek')).json();
  assert.equal(calls, 1, 'the same HTML snapshot must not be fetched twice');
  assert.equal(data.provider, 'deepseek');
  assert.equal(data.officialUrl, DEEPSEEK_OFFICIAL_URL);
  assert.equal(data.history.available, true);
  assert.equal(data.history.snapshotKind, 'official-html');
  assert.equal(data.history.rows[0].uptime, '99.00');
});

test('a DeepSeek history layout change leaves the freshly parsed summary intact', async t => {
  const get = await fixture(t, { historyEnabled: true, fetchFn: async () => text(deepseekMarkup({ rangeLabel: '' })) });
  const response = await get('/api/status/deepseek');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.stale, false); assert.ok(data.fetchedAt);
  assert.equal(data.components.length, 1);
  assert.equal(data.status.indicator, 'none');
  assert.equal(data.history.available, false);
  assert.match(data.history.error, /No uptime values or history bars have been estimated/);
});

// ===========================================================================
// Gemini: fixed read-only POST, no public config leakage, transfer controls
// ===========================================================================

test('Gemini uses only a fixed read-only POST and never returns the public client configuration', async t => {
  const calls = [];
  const get = await fixture(t, { historyEnabled: true, fetchFn: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return isTextRequest(init) ? text(geminiPage()) : json(geminiFeed(geminiIncident()));
  } });
  const response = await get('/api/status/gemini');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(calls.length, 2, 'one public page read plus exactly one RPC call');
  assert.equal(calls[0].url, GEMINI_STATUS_URL);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, GEMINI_INCIDENTS_RPC);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.body, '[]', 'the RPC body is fixed and never client-controlled');
  assert.equal(calls[1].init.headers['X-Goog-Api-Key'], GEMINI_PUBLIC_KEY);
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json+protobuf');
  assert.equal(data.incidentsAvailable, true);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(GEMINI_PUBLIC_KEY));
});

test('Gemini upstream requests enforce timeout and redirect failure, and oversized bodies fail closed', async t => {
  const inits = [];
  const get = await fixture(t, { historyEnabled: true, fetchFn: async (url, init = {}) => {
    inits.push(init);
    return isTextRequest(init) ? text(geminiPage()) : json(geminiFeed(geminiIncident()));
  } });
  await get('/api/status/gemini');
  assert.equal(inits.length, 2);
  for (const init of inits) {
    assert.equal(init.redirect, 'error', 'redirects must not be followed to arbitrary hosts');
    assert.ok(init.signal && typeof init.signal.aborted === 'boolean', 'an abort/timeout signal must be attached');
    assert.equal(init.signal.aborted, false);
  }
  const oversized = await fixture(t, { historyEnabled: true, fetchFn: async (url, init = {}) =>
    isTextRequest(init) ? text(geminiPage()) : new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  assert.equal((await oversized('/api/status/gemini')).status, 502);
});

test('Gemini still reports current incidents when history is disabled', async t => {
  const get = await fixture(t, { historyEnabled: false, fetchFn: async (url, init = {}) =>
    isTextRequest(init) ? text(geminiPage()) : json(geminiFeed(geminiIncident())) });
  const data = await (await get('/api/status/gemini')).json();
  assert.equal(data.history.available, false);
  assert.equal(data.incidents.length, 1);
});

// ===========================================================================
// Unknown providers
// ===========================================================================

test('unknown providers including glm are 404 and never trigger an upstream request', async t => {
  let calls = 0;
  const get = await fixture(t, { historyEnabled: true, fetchFn: async () => { calls++; return json(statuspageSummary()); } });
  for (const path of ['/api/status/glm', '/api/status/other', '/api/status/gemini2', '/api/status/http://evil.example', '/api/status/']) {
    assert.equal((await get(path)).status, 404, path);
  }
  assert.equal(calls, 0, 'no upstream request may be derived from an unknown provider');
});

// ===========================================================================
// Package wiring
// ===========================================================================

test('the consolidated test script includes this provider suite', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
  assert.match(pkg.scripts.test, /providers\.test\.mjs/);
});
