import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { load } from 'cheerio';
import { createStatusServer, framePolicy } from './server.mjs';
import { parseOpenAIHistory, parseClaudeHistory } from './history.mjs';

const sample = () => ({ page: { updated_at: '2026-10-13T00:00:00Z' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [{ id: 'api', name: 'API', status: 'operational' }, { id: 'group', name: 'Group', group: true }],
  incidents: [{ id: 'test', name: '<script>alert(1)</script>', status: 'monitoring', incident_updates: [{ body: 'Tracking recovery' }] },
    { id: 'done', name: 'Resolved', status: 'resolved' }], scheduled_maintenances: [] });
const ok = (data = sample()) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
async function fixture(t, options) {
  const server = createStatusServer({ historyEnabled: false, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path, init) => fetch(base + path, init);
}

test('exact iframe origins are validated and injection rejected', () => {
  assert.equal(framePolicy("'self' https://api.example.com http://localhost:8080"), "'self' https://api.example.com http://localhost:8080");
  for (const value of ['https://api.example.com/path', "https://api.example.com; script-src *", 'javascript:alert(1)', 'https://a:b@api.example.com', '']) {
    assert.throws(() => framePolicy(value));
  }
});

test('unrestricted framing is the default; exact restrictions remain optional', () => {
  assert.equal(framePolicy(), '*');
  assert.equal(framePolicy("'self'"), "'self'");
  assert.equal(framePolicy('*'), '*');
  assert.equal(framePolicy('  *  '), '*');
  for (const value of ['* https://example.com', "'self' *", '*; connect-src *', 'https://*.example.com', '**']) {
    assert.throws(() => framePolicy(value));
  }
});

test('without EMBED_ORIGINS any website can frame the portal and both pages, with local-only data connections', async t => {
  const previous = process.env.EMBED_ORIGINS;
  delete process.env.EMBED_ORIGINS;
  let get;
  try { get = await fixture(t, { fetchFn: async () => ok() }); }
  finally {
    if (previous === undefined) delete process.env.EMBED_ORIGINS;
    else process.env.EMBED_ORIGINS = previous;
  }
  for (const path of ['/', '/index.html', '/openai.html', '/claude.html']) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors \*;/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self';/);
    assert.equal(response.headers.get('x-frame-options'), null);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('generic 1Panel compose uses a local image and needs no domain or source mount', () => {
  const compose = readFileSync(new URL('./docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /image: ai-status-embed:local/);
  assert.match(compose, /pull_policy: never/);
  assert.match(compose, /127\.0\.0\.1:8099:8099/);
  assert.doesNotMatch(compose, /environment:|EMBED_ORIGINS|https?:\/\/|volumes:|build:/);
});

test('HTML serves with exact framing policy and local-only connections', async t => {
  const get = await fixture(t, { origins: 'https://api.example.com', fetchFn: async () => ok() });
  const response = await get('/?provider=claude&token=do-not-forward');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors https:\/\/api\.example\.com;/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.match(await response.text(), /Claude Status \| Official Status Data/);
});

test('normalizes official summaries and does not forward client queries', async t => {
  let requested;
  const get = await fixture(t, { fetchFn: async url => { requested = url; return ok(); } });
  const data = await (await get('/api/status/openai?token=private')).json();
  assert.equal(requested, 'https://status.openai.com/api/v2/summary.json');
  assert.equal(data.provider, 'openai'); assert.equal(data.stale, false);
  assert.equal(data.components.length, 1); assert.equal(data.incidents.length, 1);
  assert.equal(data.incidents[0].body, 'Tracking recovery');
  assert.equal(data.incidentsAvailable, true);
});

test('cache coalesces concurrent requests and expires after sixty seconds', async t => {
  let calls = 0, clock = 1800000000000;
  const get = await fixture(t, { now: () => clock, fetchFn: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return ok(); } });
  await Promise.all([get('/api/status/claude'), get('/api/status/claude'), get('/api/status/claude')]);
  assert.equal(calls, 1);
  clock += 59999; await get('/api/status/claude'); assert.equal(calls, 1);
  clock += 2; await get('/api/status/claude'); assert.equal(calls, 2);
});

test('expired cache is explicitly stale on upstream failure and recovery clears warning', async t => {
  let clock = 1800000000000, fail = false, calls = 0;
  const get = await fixture(t, { now: () => clock, fetchFn: async () => { calls++; if (fail) throw new Error('secret upstream detail'); return ok(); } });
  const first = await (await get('/api/status/openai')).json();
  clock += 61000; fail = true;
  const failed = await (await get('/api/status/openai')).json();
  assert.equal(failed.stale, true); assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.doesNotMatch(JSON.stringify(failed), /secret upstream detail/);
  await get('/api/status/openai'); assert.equal(calls, 2);
  clock += 15001; fail = false;
  const recovered = await (await get('/api/status/openai')).json();
  assert.equal(recovered.stale, false); assert.equal(recovered.error, null);
});

test('cold-start failure is 502, not a healthy status; failure retries are throttled', async t => {
  let calls = 0;
  const get = await fixture(t, { fetchFn: async () => { calls++; throw new Error('offline'); } });
  const response = await get('/api/status/claude');
  assert.equal(response.status, 502);
  const data = await response.json(); assert.equal(data.fetchedAt, null); assert.equal(data.stale, true);
  assert.equal(data.status, undefined);
  await get('/api/status/claude'); assert.equal(calls, 1);
});

test('unsupported upstream schema fails closed', async t => {
  const get = await fixture(t, { fetchFn: async () => ok({ components: [] }) });
  assert.equal((await get('/api/status/openai')).status, 502);
});

test('missing incidents are not misrepresented as no incidents', async t => {
  const data = sample(); delete data.incidents;
  const get = await fixture(t, { fetchFn: async () => ok(data) });
  assert.equal((await (await get('/api/status/openai')).json()).incidentsAvailable, false);
});

test('unknown providers and arbitrary URLs cannot become upstream requests', async t => {
  let calls = 0;
  const get = await fixture(t, { fetchFn: async () => { calls++; return ok(); } });
  for (const path of ['/api/status/other', '/api/status/http://localhost', '/server.mjs', '/package.json']) {
    assert.equal((await get(path)).status, 404);
  }
  assert.equal(calls, 0);
});

test('oversized upstream responses are rejected', async t => {
  const get = await fixture(t, { fetchFn: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  assert.equal((await get('/api/status/openai')).status, 502);
});

test('HTTP failures do not become successful status data', async t => {
  const get = await fixture(t, { fetchFn: async () => new Response('{}', { status: 503 }) });
  assert.equal((await get('/api/status/claude')).status, 502);
});

test('HEAD has no body and unsupported methods return 405', async t => {
  const server = createStatusServer({ fetchFn: async () => ok() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal(await (await fetch(base, { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

for (const provider of ['openai', 'claude', 'gemini', 'deepseek', 'kimi']) {
  test(`${provider} is a separate all-English page with official attribution and safe DOM rendering`, () => {
    const html = readFileSync(new URL(`./${provider}.html`, import.meta.url), 'utf8');
    const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(js));
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.match(html, /Official status data/);
    assert.match(html, /Self-hosted display; not operated by/);
    assert.doesNotMatch(js, /innerHTML|document\.write|localStorage|sessionStorage|Math\.random/);
    assert.match(js, /node\.textContent=text/);
    assert.match(js, /location\.protocol==='file:'/);
    assert.match(js, /\/api\/status\/\x27\+provider/);
    assert.doesNotMatch(html, /class="tabs"|data-provider="all"/);
  });
  test(`${provider} scales readable typography with its own viewport without disabling browser zoom`, () => {
    const html = readFileSync(new URL(`./${provider}.html`, import.meta.url), 'utf8');
    assert.match(html, /width=device-width, initial-scale=1/);
    assert.match(html, /font-size:clamp\(1rem,calc\(\.875rem \+ \.3vw\),1\.1875rem\)/);
    assert.match(html, /body\{font-size:1rem;line-height:1\.5\}/);
    assert.match(html, /\.name\{min-width:0;font-size:1rem(?:;|\})/);
    assert.match(html, /\.source\{font-size:\.8125rem/);
    assert.match(html, /@media\(max-width:560px\)/);
    assert.match(html, /@media\(max-width:360px\)/);
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale|\bzoom\s*:|transform\s*:\s*scale\(|parent\.document/);
  });
}

test('separate routes cannot be switched to the other provider by query parameters', async t => {
  const get = await fixture(t, { fetchFn: async () => ok() });
  const openai = await (await get('/openai.html?provider=claude')).text();
  const claude = await (await get('/claude.html?provider=openai')).text();
  assert.match(openai, /<h1>OpenAI<\/h1>/); assert.doesNotMatch(openai, /<h1>Claude/);
  assert.match(claude, /<h1>Claude<\/h1>/); assert.doesNotMatch(claude, /<h1>OpenAI/);
  assert.equal((await get('/openai')).status, 200); assert.equal((await get('/claude')).status, 200);
});

test('the root and index serve the selection portal instead of silently choosing a provider', async t => {
  let calls = 0;
  const get = await fixture(t, { fetchFn: async () => { calls++; return ok(); } });
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  for (const path of ['/', '/index.html', '/?theme=dark&token=private', '/?provider=unknown', '/index.html?provider=']) {
    const response = await get(path, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await response.text(), html);
  }
  assert.equal(calls, 0, 'the selection portal must not fetch or imply live status');
  const head = await get('/', { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('explicit legacy provider links still redirect, carrying only a valid theme', async t => {
  const get = await fixture(t, {});
  for (const path of ['/', '/index.html']) {
    for (const provider of ['openai', 'claude', 'gemini', 'deepseek', 'kimi']) {
      for (const theme of ['light', 'dark', 'invalid', 'dark%3Btoken%3Dsecret']) {
        const response = await get(`${path}?provider=${provider}&theme=${theme}&token=secret&redirect=https://example.com`, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), `/${provider}.html` + (['light', 'dark'].includes(theme) ? `?theme=${theme}` : ''));
      }
    }
  }
});

test('the portal is English, self-contained, accessible and has real relative navigation without invented health data', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const $ = load(html);
  assert.equal($('html').attr('lang'), 'en');
  assert.equal($('h1').length, 1);
  assert.equal($('h1').text(), 'Choose a status page.');
  assert.deepEqual($('nav a').map((_, link) => $(link).attr('href')).get(), ['./openai.html', './claude.html', './gemini.html', './deepseek.html', './kimi.html']);
  assert.match($('body').text(), /Official status data/);
  assert.equal($('footer, .note').length, 0);
  assert.doesNotMatch($('body').text(), /Self-hosted display; not operated by the listed providers|Live data loads on the selected page|GLM is not listed/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /font-size:clamp\(1rem,calc\(\.875rem \+ \.3vw\),1\.1875rem\)/);
  assert.equal($('script[src], link[href], img[src], iframe, meta[http-equiv="refresh"]').length, 0);
  assert.doesNotMatch(html, /[\u3400-\u9fff]|user-scalable=no|maximum-scale/i);
  assert.doesNotMatch($('main').text(), /100%|fully operational|All Systems Operational/i);
  assert.doesNotMatch($('script').text(), /fetch\(|location\.(assign|replace|href)|innerHTML|document\.write|localStorage|sessionStorage|Math\.random/);
});

test('portal navigation retains only supported themes, never tokens or other client parameters', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = load(html)('script').text();
  for (const theme of ['', 'light', 'dark', 'invalid', 'dark%3Btoken%3Dsecret']) {
    const links = ['openai', 'claude', 'gemini', 'deepseek', 'kimi'].map(provider => ({
      dataset: { statusLink: provider }, href: `./${provider}.html`,
      setAttribute(name, value) { assert.equal(name, 'href'); this.href = value; }
    }));
    const document = { documentElement: { dataset: {} }, querySelectorAll: selector => {
      assert.equal(selector, '[data-status-link]'); return links;
    } };
    runInNewContext(js, { URLSearchParams, location: { search: `?theme=${theme}&token=secret&access_token=secret&redirect=https://example.com` }, document });
    const suffix = ['light', 'dark'].includes(theme) ? `?theme=${theme}` : '';
    assert.equal(document.documentElement.dataset.theme, suffix ? theme : undefined);
    assert.deepEqual(links.map(link => link.href), ['openai', 'claude', 'gemini', 'deepseek', 'kimi'].map(provider => `./${provider}.html${suffix}`));
  }
});

test('container includes the portal and package versions agree', () => {
  const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
  for (const file of ['server.mjs', 'history.mjs', 'gemini.mjs', 'deepseek.mjs', 'kimi.mjs', 'index.html', 'openai.html', 'claude.html', 'gemini.html', 'deepseek.html', 'kimi.html']) assert.ok(dockerfile.split('\n').find(line => line.startsWith('COPY --chown=node:node '))?.split(/\s+/).includes(file), `${file} must be copied into the container`);
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url)));
  assert.equal(pkg.version, '1.6.9');
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
});

test('exact direct dependencies match the lockfile version and resolved package archive', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url)));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} must be locked`);
    assert.equal(entry.version, version, `${name} lockfile version must match the exact dependency`);
    const archive = name.split('/').at(-1) + '-' + version + '.tgz';
    assert.ok(new URL(entry.resolved).pathname.endsWith('/' + archive), `${name} archive must match its locked version`);
    assert.match(entry.integrity, /^sha512-/);
  }
});

function openaiPageHarness(provider = 'openai') {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.className = ''; this.value = ''; }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.value = ''; this.children = [...children]; }
    addEventListener() {}
  }
  const nodes = Object.fromEntries(['banner','banner-head','banner-body','notice','incidents','incident-list','rows','period','timestamp','refresh'].map(id => [id, new Node('div')]));
  const document = { body: { dataset: { provider } }, documentElement: { dataset: {} },
    getElementById: id => nodes[id], createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), addEventListener() {} };
  const context = { document, URLSearchParams, location: { search: '', protocol: 'https:' }, matchMedia: () => ({ matches: false }),
    setInterval() {}, fetch: () => new Promise(() => {}), AbortSignal, Intl, Date };
  const html = readFileSync(new URL(`./${provider}.html`, import.meta.url), 'utf8');
  runInNewContext(load(html)('script').text(), context);
  return { nodes, context };
}

function pageData() {
  return { provider: 'openai', fetchedAt: '2026-10-13T08:20:00Z', stale: false, status: { indicator: 'minor', description: 'Partial System Degradation' },
    components: [], incidentsAvailable: true,
    incidents: [{ id: 'official-incident', name: 'Degraded performance in Codex and Work mode', body: 'We are investigating the issue for the listed services.', status: 'investigating', impact: 'minor', updatedAt: '2026-10-13T08:18:00Z' }],
    history: { available: true, stale: false, fetchedAt: '2026-10-13T08:20:01Z', rangeLabel: 'Jul 2026 - Oct 2026', rows: [],
      overall: { status: 'operational', title: "We're fully operational", description: 'No issues are reported.' },
      incidents: [{ id: 'official-incident', impact: 'degraded_performance', affectedComponents: ['ChatGPT','Codex'], durationText: 'Ongoing for 10 minutes' }] } };
}

test('OpenAI and Claude have identical inline styles and rendering logic while retaining provider-specific official links', () => {
  const pages = ['openai', 'claude', 'gemini', 'deepseek', 'kimi'].map(provider => readFileSync(new URL(`./${provider}.html`, import.meta.url), 'utf8'));
  const parsed = pages.map(html => load(html));
  assert.equal(parsed[0]('style').text(), parsed[1]('style').text());
  assert.equal(parsed[0]('script').text(), parsed[1]('script').text());
  for (const html of pages) {
    assert.ok(html.indexOf('id="incidents"') < html.indexOf('class="system"'));
    assert.match(html, /<h2 id="system-title">System status<\/h2>/);
    assert.match(html, /class="history-link"/);
    assert.match(html, /max-width:48rem/);
    assert.match(html, /height:1rem/);
  }
  assert.equal(parsed[0]('.history-link').attr('href'), 'https://status.openai.com/history');
  assert.equal(parsed[1]('.history-link').attr('href'), 'https://status.claude.com/uptime');
});

function claudePageData() {
  return { provider: 'claude', fetchedAt: '2026-10-13T10:00:00Z', stale: false, incidentsAvailable: true,
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [{ name: 'Claude API', status: 'operational' }], incidents: [],
    history: { available: true, stale: false, fetchedAt: '2026-10-13T10:00:01Z', rangeLabel: 'Past 90 days',
      rows: [{ name: 'Claude API', status: 'operational', uptime: '99.47', components: [],
        days: [{ state: 'major_outage', color: '#e04343', date: '2026-10-12', events: ['A published outage'] },
          { state: 'operational', color: '#76ad2a', date: '2026-10-13', events: [] }] }] } };
}

test('Claude uses the unified row layout without changing official uptime, dates, incidents or bar order', () => {
  const { context, nodes } = openaiPageHarness('claude');
  const data = claudePageData(), original = JSON.stringify(data);
  context.render(data);
  const row = nodes.rows.children[0];
  assert.equal(row.className, 'group-row');
  assert.match(row.textContent, /99\.47% uptime/);
  assert.deepEqual(Array.from(row.children[1].children, bar => bar.className), ['bar major_outage', 'bar operational']);
  assert.equal(row.children[1].children[0].title, '2026-10-12 — Major Outage\nA published outage');
  assert.equal(row.children[1].children[0].style.backgroundColor, '#e04343', 'known states must retain their official daily fill rather than the shared theme palette');
  assert.equal(nodes.period.textContent, 'Past 90 days');
  assert.match(nodes.timestamp.textContent, /Official history snapshot:/);
  assert.doesNotMatch(nodes.timestamp.textContent, /Official HTML snapshot/);
  assert.equal(JSON.stringify(data), original, 'rendering must not modify the official data');
});

test('Claude active events use the same top incident card with only officially provided affected services', () => {
  const { context, nodes } = openaiPageHarness('claude'), data = claudePageData();
  data.incidents = [{ id: 'claude-event', name: 'Elevated API errors', body: 'We are monitoring recovery.', status: 'monitoring', impact: 'minor',
    updatedAt: '2026-10-13T09:55:00Z', affectedComponents: ['Claude API'] }];
  context.render(data);
  assert.equal(nodes.banner.hidden, true);
  assert.equal(nodes.incidents.hidden, false);
  assert.match(nodes['incident-list'].textContent, /Elevated API errors/);
  assert.match(nodes['incident-list'].textContent, /Monitoring · Updated .* · Affects Claude API/);
  assert.doesNotMatch(nodes['incident-list'].textContent, /Ongoing|ChatGPT|Codex/);
  assert.equal(nodes['incident-list'].children[0].children[0].children[0].children[0].tagName, 'path');
  data.incidents = []; context.render(data);
  assert.equal(nodes.incidents.hidden, true); assert.equal(nodes.banner.hidden, false);
  assert.equal(nodes['incident-list'].children.length, 0);
});

test('Claude cold failures clear old cards and missing uptime never becomes 100 percent', () => {
  const { context, nodes } = openaiPageHarness('claude'), data = claudePageData();
  data.history.rows[0].uptime = null; context.render(data);
  assert.doesNotMatch(nodes.rows.textContent, /% uptime/);
  data.incidents = [{ name: 'A cached incident', status: 'investigating', impact: 'minor' }]; context.render(data);
  context.render({ error: 'Unable to fetch official status data.' });
  assert.equal(nodes.banner.hidden, false); assert.equal(nodes.banner.className, 'banner unknown');
  assert.equal(nodes.incidents.hidden, true); assert.equal(nodes['incident-list'].children.length, 0);
  assert.equal(nodes['banner-head'].textContent, 'Official status unavailable');
});

test('Claude warns on stale or unavailable history and a missing summary incident list', () => {
  const { context, nodes } = openaiPageHarness('claude'), data = claudePageData();
  data.history.stale = true; data.history.error = 'History refresh failed.'; context.render(data);
  assert.match(nodes.notice.textContent, /History refresh failed/);
  data.history = { available: false, error: 'Official history is unavailable. No uptime data has been estimated.' };
  data.incidentsAvailable = false; data.components[0].status = 'degraded_performance'; context.render(data);
  assert.match(nodes.notice.textContent, /No uptime data has been estimated/);
  assert.match(nodes.notice.textContent, /did not include an incident list/);
  assert.equal(nodes.banner.className, 'banner warn');
  assert.doesNotMatch(nodes.rows.textContent, /% uptime/);
  assert.equal(nodes.period.textContent, 'History unavailable');
});

function warningHtml() {
  return officialHtml().replace(/<div data-testid="heads-up">[\s\S]*?<\/div><\/div>/, `<div data-testid="heads-up"><li><svg class="text-icon-degraded"></svg>We're currently experiencing issues</li>
    <div class="p-4"><div class="ComponentBadge__degraded"><span>ChatGPT</span></div><div class="ComponentBadge__degraded"><span>Codex</span></div></div>
    <a href="/incidents/official-incident"><svg class="text-icon-degraded"></svg><div class="font-medium">Degraded performance in Codex and Work mode</div><p>We are investigating the issue for the listed services.</p>
    <div><span>Investigating</span><span>Ongoing for <var duration>10</var> minutes</span><span>Affects ChatGPT, Codex</span></div></a></div>`);
}

test('OpenAI warning banners distinguish service badges from real incident descriptions', () => {
  const data = parseOpenAIHistory(warningHtml());
  assert.equal(data.snapshotKind, 'official-html');
  assert.equal(data.overall.description, '');
  assert.equal(data.overall.status, 'degraded_performance');
  assert.equal(data.incidents.length, 1);
  assert.equal(data.incidents[0].name, 'Degraded performance in Codex and Work mode');
  assert.equal(data.incidents[0].body, 'We are investigating the issue for the listed services.');
  assert.equal(data.incidents[0].status, 'investigating');
  assert.deepEqual(data.incidents[0].affectedComponents, ['ChatGPT','Codex']);
  assert.equal(data.incidents[0].durationText, 'Ongoing for 10 minutes');
  assert.equal(data.rows[0].uptime, '99.95', 'the published value must not be offset or rounded');
});

test('OpenAI incident metadata fails closed for malformed links and unsupported duration text', () => {
  assert.equal(parseOpenAIHistory(warningHtml().replace('/incidents/official-incident', '/incidents/official-incident?token=private')).incidents.length, 0);
  const data = parseOpenAIHistory(warningHtml().replace('Ongoing for <var duration>10</var> minutes', 'Estimated <var duration>10</var> minutes'));
  assert.equal(data.incidents[0].durationText, null);
});

test('OpenAI renders specific incident cards before system status, not merged badges or a healthy overview', () => {
  const { context, nodes } = openaiPageHarness();
  context.render(pageData());
  assert.equal(nodes.banner.hidden, true);
  assert.equal(nodes.incidents.hidden, false);
  const card = nodes['incident-list'].children[0];
  assert.match(card.textContent, /Degraded performance in Codex and Work mode/);
  assert.match(card.textContent, /We are investigating the issue for the listed services/);
  assert.match(card.textContent, /Investigating · Ongoing for 10 minutes · Affects ChatGPT, Codex/);
  assert.doesNotMatch(card.textContent, /ChatGPTCodex|fully operational|No issues/);
  assert.equal(card.children[0].children[0].children[0].tagName, 'path', 'degraded status must use a triangle');
  const html = readFileSync(new URL('./openai.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="incidents"') < html.indexOf('class="system"'));
});

test('OpenAI handles multiple incidents and never infers affected services from unrelated component failures', () => {
  const { context, nodes } = openaiPageHarness(), data = pageData();
  data.history.incidents = [];
  data.components = [{name:'An unrelated service',status:'degraded_performance'}];
  data.incidents.push({id:'another-incident',name:'A second official incident',body:'Monitoring recovery.',status:'monitoring',impact:'major'});
  context.render(data);
  assert.equal(nodes['incident-list'].children.length, 2);
  assert.doesNotMatch(nodes['incident-list'].textContent, /Affects|Ongoing|An unrelated service/);
  assert.match(nodes['incident-list'].children[1].className, /bad/);
});

test('stale HTML metadata cannot annotate fresh incidents or resurrect a resolved incident', () => {
  const { context, nodes } = openaiPageHarness(), data = pageData();
  data.history.stale = true; data.history.error = 'History refresh failed.';
  context.render(data);
  assert.doesNotMatch(nodes['incident-list'].textContent, /Ongoing|Affects/);
  assert.equal(nodes.notice.hidden, false);
  data.incidents = []; data.status = {indicator:'none',description:'All Systems Operational'};
  context.render(data);
  assert.equal(nodes.incidents.hidden, true); assert.equal(nodes.banner.hidden, false);
  assert.equal(nodes['incident-list'].children.length, 0);
});

test('whole-response refresh failures disable HTML annotations even when its own stale flag is false', () => {
  const { context, nodes } = openaiPageHarness(), data = pageData();
  data.stale = true; data.error = 'Refresh failed. Showing previously fetched official data.';
  context.render(data);
  assert.equal(nodes.incidents.hidden, false, 'cached summary incidents remain visible with a stale warning');
  assert.doesNotMatch(nodes['incident-list'].textContent, /Ongoing|Affects/);
  assert.match(nodes['incident-list'].textContent, /Updated/);
  assert.match(nodes.notice.textContent, /Refresh failed/);
  data.incidentsAvailable = false; data.incidents = [];
  context.render(data);
  assert.equal(nodes.incidents.hidden, true, 'stale whole responses cannot use HTML-only incident fallback');
});

test('summary impact none cannot inherit a conflicting HTML severity', () => {
  const { context, nodes } = openaiPageHarness(), data = pageData();
  data.incidents[0].impact = 'none'; data.history.incidents[0].impact = 'major_outage';
  context.render(data);
  assert.equal(nodes['incident-list'].children[0].className, 'banner incident unknown');
  assert.doesNotMatch(nodes['incident-list'].children[0].className, /bad|good/);
});

test('incident headers override overview banner colors with a white or theme-native surface', () => {
  const html = readFileSync(new URL('./openai.html', import.meta.url), 'utf8');
  assert.match(html, /\.banner\.incident \.banner-head\{[^}]*background:transparent/);
  assert.ok(html.indexOf('.banner.incident .banner-head') > html.indexOf('.banner.warn .banner-head'));
});

test('cold-start status failure never shows a healthy banner or old incident cards', () => {
  const { context, nodes } = openaiPageHarness();
  context.render(pageData()); context.render({error:'Unable to fetch official status data.'});
  assert.equal(nodes.banner.hidden, false); assert.match(nodes.banner.className, /unknown/);
  assert.equal(nodes['banner-head'].textContent, 'Official status unavailable');
  assert.equal(nodes.incidents.hidden, true); assert.equal(nodes['incident-list'].children.length, 0);
});

test('missing summary incidents use only fresh official HTML cards and disclose the missing list', () => {
  const { context, nodes } = openaiPageHarness(), data = pageData();
  data.incidentsAvailable = false; data.incidents = [];
  data.history.incidents[0] = {...data.history.incidents[0],name:'Official HTML incident',body:'Published update',status:'investigating'};
  context.render(data);
  assert.match(nodes['incident-list'].textContent, /Official HTML incident/);
  assert.match(nodes.notice.textContent, /did not include an incident list/);
});

test('incident text is literal and the history values and bar sequence stay exactly as published', () => {
  const { context, nodes } = openaiPageHarness(), data = pageData();
  data.incidents[0].name = '<script>alert(1)</script>'; data.incidents[0].body = '<img src=x onerror=alert(1)>';
  data.history.rows = [{name:'APIs',status:'operational',uptime:'99.96',days:[{state:'operational'},{state:'degraded_performance'},{state:'partial_outage'}],components:[]}];
  context.render(data);
  assert.match(nodes['incident-list'].textContent, /<script>alert\(1\)<\/script>/);
  const row = nodes.rows.children[0];
  assert.match(row.textContent, /99\.96% uptime/);
  assert.deepEqual(Array.from(row.children[1].children, bar => bar.className), ['bar operational','bar degraded_performance','bar partial_outage']);
  assert.match(nodes.timestamp.textContent, /Official HTML snapshot:/);
});

test('summary normalization preserves official incident timestamps and affected service names', async t => {
  const source = sample(); source.incidents[0].created_at = '2026-10-13T08:10:00Z'; source.incidents[0].components = [{name:'ChatGPT'},{name:'Codex'}];
  const get = await fixture(t, {fetchFn:async () => ok(source)});
  const data = await (await get('/api/status/openai')).json();
  assert.equal(data.incidents[0].createdAt, source.incidents[0].created_at);
  assert.deepEqual(data.incidents[0].affectedComponents, ['ChatGPT','Codex']);
});

function officialHtml() {
  const chart = state => '<svg>' + Array.from({length: 91}, () => `<rect class="UptimeChart__pill${state}"></rect>`).join('') + '</svg>';
  return `<div data-testid="heads-up"><li><svg class="text-icon-operational"></svg>We're fully operational</li><div class="p-4">No issues are reported.</div></div>
    <div data-testid="system-status"><span class="select-none">Jul 2026-Oct 2026</span><div class="divide-y"><div>
    <div class="h-7"><svg class="text-icon-operational"></svg><h3>APIs</h3><var percentage>99.95</var></div>
    <div><div class="h-7"><svg class="text-icon-operational"></svg><h3>Responses</h3><var percentage>100</var></div>${chart('Operational')}</div>
    ${chart('PartialOutage')}</div></div></div>`;
}
test('OpenAI uses official group uptime and group bars, not the first child chart', () => {
  const data = parseOpenAIHistory(officialHtml());
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].name, 'APIs');
  assert.equal(data.rows[0].uptime, '99.95'); assert.equal(data.rows[0].componentCount, 1);
  assert.equal(data.rows[0].days.length, 91); assert.equal(data.rows[0].days[0].state, 'partial_outage');
  assert.equal(data.rows[0].components[0].days[0].state, 'operational');
  assert.equal(data.overall.status, 'operational'); assert.equal(data.rangeLabel, 'Jul 2026 - Oct 2026');
});

test('a group without a published chart cannot inherit a collapsed child chart or uptime', () => {
  const chart = '<svg>' + '<rect class="chart__pillOperational"/>'.repeat(20) + '</svg>';
  const header = name => `<div class="h-7"><svg class="text-icon-operational"></svg><h3>${name}</h3></div>`;
  const html = `<div data-testid="system-status"><div class="divide-y"><div>${header('APIs')}${chart}</div>
    <div>${header('Ads Platform')}<div data-state="closed"><div>${header('Child')}<var percentage>99.9</var>${chart}</div></div></div></div></div>`;
  const data = parseOpenAIHistory(html);
  assert.equal(data.rows[1].days.length, 0); assert.equal(data.rows[1].uptime, null);
  assert.equal(data.rows[1].components[0].days.length, 20);
});

test('unknown history classes are not shown as operational, and missing upstream markup fails closed', () => {
  const data = parseOpenAIHistory(officialHtml().replaceAll('pillPartialOutage', 'pillUnexpected'));
  assert.equal(data.rows[0].days[0].state, 'unknown');
  assert.throws(() => parseOpenAIHistory('<html>Layout changed</html>'));
});

function claudeShowcase() {
  const rects = Array.from({length: 90}, (_, i) => `<rect class="uptime-day day-${i}" fill="${i ? '#76ad2a' : '#e04343'}"/>`).join('');
  return { components: { api: `<svg>${rects}</svg>` }, values: [{component:'api',ninety:99.47}],
    timelines: { api: {days:Array.from({length:90}, (_,i) => ({date:'2026-10-01',related_events:i?[]:[{name:'An official outage'}]}))} } };
}
test('Claude uses the published ninety-day metric, exact colors and related incident data', () => {
  const data = parseClaudeHistory(claudeShowcase(), [{id:'api',name:'Claude API',status:'operational'}]);
  assert.equal(data.rows[0].uptime, '99.47'); assert.equal(data.rows[0].days.length, 90);
  assert.equal(data.rows[0].days[0].state, 'major_outage'); assert.equal(data.rows[0].days[0].color, '#e04343');
  assert.equal(data.rows[0].days[1].state, 'operational');
  assert.deepEqual(data.rows[0].days[0].events, ['An official outage']);
});

test('Claude keeps interpolated official fills without inventing a discrete outage severity', () => {
  const fills = ['#ed7532', '#beaa2a', '#d1a92a', '#e5553b', '#b3bac5'];
  const source = claudeShowcase();
  source.components.api = '<svg>' + Array.from({ length: 90 }, (_, i) => `<rect class="uptime-day day-${i}" fill="${fills[i % fills.length]}"/>`).join('') + '</svg>';
  const rows = parseClaudeHistory(source, [{ id: 'api', name: 'API', status: 'operational' }]).rows;
  assert.deepEqual(rows[0].days.slice(0, 5).map(day => day.color), fills);
  assert.deepEqual(rows[0].days.slice(0, 5).map(day => day.state), ['official_history', 'official_history', 'official_history', 'official_history', 'unknown']);
  assert.equal(rows[0].uptime, '99.47');
  assert.equal(rows[0].days[0].date, '2026-10-01');
  assert.deepEqual(rows[0].days[0].events, ['An official outage']);
});

test('Claude rejects non-hex fills and keeps unknown history distinct from operational', () => {
  for (const fill of ['url(https://example.invalid/pixel)', 'var(--fake-green)', 'red', '#00ff00;opacity:0', '#fff', 'rgb(0, 255, 0)', '']) {
    const source = claudeShowcase();
    source.components.api = '<svg>' + `<rect class="uptime-day day-0" fill="${fill}"/>`.repeat(90) + '</svg>';
    const first = parseClaudeHistory(source, [{ id: 'api', name: 'API' }]).rows[0].days[0];
    assert.equal(first.color, null, fill);
    assert.equal(first.state, 'unknown', fill);
  }
});

test('Claude recognizes only the actual pure official palette while keeping its exact colors', () => {
  const fills = ['#76AD2A', '#FAA72A', '#E86235', '#E04343', '#2C84DB'];
  const source = claudeShowcase();
  source.components.api = '<svg>' + Array.from({ length: 90 }, (_, i) => `<rect class="uptime-day day-${i}" fill=" ${fills[i % fills.length]} "/>`).join('') + '</svg>';
  const days = parseClaudeHistory(source, [{ id: 'api', name: 'API' }]).rows[0].days;
  assert.deepEqual(days.slice(0, 5).map(day => day.color), fills.map(fill => fill.toLowerCase()));
  assert.deepEqual(days.slice(0, 5).map(day => day.state), ['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
});

test('missing Claude metrics are not fabricated as 100 percent', () => {
  const source = claudeShowcase(); source.values = [];
  assert.equal(parseClaudeHistory(source,[{id:'api',name:'API'}]).rows[0].uptime, null);
  assert.throws(() => parseClaudeHistory({components:{},values:[]},[{id:'api'}]));
});

test('a failed history refresh keeps current status available and does not estimate history', async t => {
  const get = await fixture(t, { historyEnabled:true, fetchFn:async url => {
    if (url.endsWith('/summary.json')) return ok();
    throw new Error('Official history unavailable');
  } });
  const response = await get('/api/status/openai'); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.stale, false); assert.equal(data.history.available, false);
  assert.match(data.history.error, /No uptime values or history bars have been estimated/);
  assert.doesNotMatch(JSON.stringify(data), /[\u3400-\u9fff]/);
});

test('cached history has its own stale flag and original retrieval time after a refresh failure', async t => {
  let clock = 1800000000000, historyFails = false;
  const get = await fixture(t, { historyEnabled:true, now:()=>clock, fetchFn:async url => {
    if(url.endsWith('/summary.json')) return ok();
    if(historyFails) throw new Error('Offline');
    return new Response(officialHtml());
  } });
  const first = await (await get('/api/status/openai')).json();
  clock += 61000; historyFails = true;
  const next = await (await get('/api/status/openai')).json();
  assert.equal(next.stale, false); assert.equal(next.history.stale, true);
  assert.equal(next.history.fetchedAt, first.history.fetchedAt); assert.equal(next.history.rows[0].uptime, '99.95');
});
