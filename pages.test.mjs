import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

const PROVIDERS = ['openai', 'claude', 'gemini', 'deepseek', 'kimi'];
const page = provider => readFileSync(new URL(`./${provider}.html`, import.meta.url), 'utf8');
const script = html => load(html)('script').text();
const style = html => load(html)('style').text();

// Every page must ship the exact same inline style and logic; only head metadata,
// body dataset, the brand SVG, H1 heading and official URLs may differ.
test('all provider pages share one identical inline stylesheet and one identical script', () => {
  const pages = PROVIDERS.map(page);
  const first = { style: style(pages[0]), script: script(pages[0]) };
  for (const html of pages) {
    assert.equal(style(html), first.style, 'the unified stylesheet must be byte-identical');
    assert.equal(script(html), first.script, 'the unified rendering logic must be byte-identical');
  }
});

test('every provider page is all-English, self-contained and parses without dependencies', () => {
  for (const provider of PROVIDERS) {
    const html = page(provider);
    const js = script(html);
    assert.doesNotThrow(() => new Function(js));
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
    assert.equal(load(html)('script[src], link[href], img[src], iframe, meta[http-equiv="refresh"]').length, 0);
    assert.doesNotMatch(js, /innerHTML|document\.write|localStorage|sessionStorage|Math\.random/);
    assert.match(js, /node\.textContent=text/);
    assert.match(js, /location\.protocol==='file:'/);
    assert.match(js, /\/api\/status\/\x27\+provider/);
    assert.match(js, /document\.createElementNS/);
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale|\bzoom\s*:|parent\.document/);
  }
});

test('each page declares its provider, official source, operator and title', () => {
  const expected = {
    openai: { title: 'OpenAI Status | Official Status Data', official: 'https://status.openai.com', operator: 'OpenAI', h1: 'OpenAI' },
    claude: { title: 'Claude Status | Official Status Data', official: 'https://status.claude.com', operator: 'Anthropic', h1: 'Claude' },
    gemini: { title: 'Gemini Status | Official Status Data', official: 'https://aistudio.google.com/status', operator: 'Google', h1: 'Gemini' },
    deepseek: { title: 'DeepSeek Status | Official Status Data', official: 'https://status.deepseek.com', operator: 'DeepSeek', h1: 'DeepSeek' },
    kimi: { title: 'Kimi Status | Official Status Data', official: 'https://status.moonshot.cn', operator: 'Moonshot AI', h1: 'Kimi' }
  };
  for (const provider of PROVIDERS) {
    const html = page(provider), $ = load(html), spec = expected[provider];
    assert.equal($('head title').text(), spec.title);
    assert.equal($('body').attr('data-provider'), provider);
    assert.equal($('body').attr('data-official'), spec.official);
    assert.equal($('body').attr('data-operator'), spec.operator);
    assert.equal($('h1').text(), spec.h1);
    assert.match(html, /Official status data/);
    assert.match($('footer') .text() + $('.source').text(), /Self-hosted display; not operated by/);
  }
});

test('Gemini uses its official status URL for every link and states its scope without estimating metrics', () => {
  const html = page('gemini'), $ = load(html);
  const official = 'https://aistudio.google.com/status';
  const external = $('a[href^="http"]').map((_, link) => $(link).attr('href')).get();
  assert.ok(external.length >= 4, 'the page must link out to its official source');
  assert.deepEqual([...new Set(external)], [official], 'every external link must be the official Gemini status URL');
  assert.equal($('.history-link').attr('href'), official);
  assert.equal($('.period-nav a').attr('href'), official);
  assert.equal($('.source a').attr('href'), official);
  const text = $('.source').text();
  assert.match(text, /Covers Gemini API and Google AI Studio; not Vertex AI or the Gemini consumer app/);
  assert.match(text, /not estimated/);
});

test('DeepSeek links only to its official status domain', () => {
  const html = page('deepseek'), $ = load(html);
  const external = [...new Set($('a[href^="http"]').map((_, link) => $(link).attr('href')).get())];
  assert.deepEqual(external, ['https://status.deepseek.com']);
  assert.equal($('.history-link').attr('href'), 'https://status.deepseek.com');
  assert.match($('.source').text(), /not estimates/);
});

test('Kimi keeps the official custom-domain identity while its history button uses the Statuspage host', () => {
  const html = page('kimi'), $ = load(html);
  const external = [...new Set($('a[href^="http"]').map((_, link) => $(link).attr('href')).get())].sort();
  assert.deepEqual(external, ['https://10y9y5wx5xh3.statuspage.io/history', 'https://status.moonshot.cn']);
  assert.equal($('.source a').attr('href'), 'https://status.moonshot.cn');
  assert.equal($('.subscribe').attr('href'), 'https://status.moonshot.cn');
  assert.equal($('.history-link').attr('href'), 'https://10y9y5wx5xh3.statuspage.io/history');
  assert.match($('.source').text(), /Covers the services listed by Moonshot AI, including Kimi, Open API and Kimi Code/);
});

test('the portal lists all five providers in an adaptive grid without invented health data or live queries', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8'), $ = load(html);
  assert.equal($('html').attr('lang'), 'en');
  assert.equal($('h1').length, 1);
  assert.deepEqual($('nav a').map((_, link) => $(link).attr('href')).get(),
    ['./openai.html', './claude.html', './gemini.html', './deepseek.html', './kimi.html']);
  assert.deepEqual($('nav a').map((_, link) => $(link).attr('data-status-link')).get(), PROVIDERS);
  assert.match(html, /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,17\.5rem\),1fr\)\)/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /\.providers\{grid-template-columns:1fr/);
  assert.doesNotMatch(style(html), /\.claude|--claude/, 'Claude must not keep a distinct card background');
  assert.equal($('footer, .note').length, 0, 'the portal must not restore the removed bottom notes or footer divider');
  assert.doesNotMatch($('body').text(), /Live data loads on the selected page|Missing history or uptime is never estimated|GLM is not listed|Self-hosted display; not operated by the listed providers/);
  assert.doesNotMatch(style(html), /\.note\{|footer(?: p)?\{/);
  assert.doesNotMatch($('main').text(), /No official status page exists/i);
  assert.equal($('script[src], link[href], img[src], iframe').length, 0);
  assert.doesNotMatch($('script').text(), /fetch\(|location\.(assign|replace|href)|innerHTML|document\.write|Math\.random/);
  assert.doesNotMatch($('main').text(), /100%|fully operational|All Systems Operational/i);
});

test('the portal adds columns as its viewport grows and caps the ultra-wide shell instead of stretching cards indefinitely', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8'), $ = load(html);
  const css = style(html);
  const shell = css.match(/(?:^|\n)\.shell\{([^}]+)\}/)?.[1];
  assert.ok(shell, 'the portal needs a base shell rule');
  assert.match(shell, /(?:^|;)width:100%(?:;|$)/);
  assert.match(shell, /(?:^|;)max-width:130rem(?:;|$)/);
  assert.match(shell, /(?:^|;)padding:2rem clamp\(1\.5rem,3vw,3rem\)(?:;|$)/);
  assert.match(css, /@media\(max-width:640px\)\{\.shell\{padding:1\.25rem\}/);
  assert.match(css, /@media\(max-width:360px\)\{\.shell\{padding:1rem\}/);
  assert.match(css, /\.providers\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,17\.5rem\),1fr\)\)/);
  assert.doesNotMatch(css, /grid-template-columns:repeat\(2,/);
  assert.match(css, /\.providers\{grid-template-columns:1fr/);
  assert.equal($('nav a.provider').length, 5, 'auto-fit must collapse empty tracks after the five available cards');
  assert.match(css, /\.source-label\{min-width:0;overflow-wrap:anywhere;/, 'source domains must wrap rather than overflow narrow cards');
  assert.equal($('meta[name="viewport"]').attr('content'), 'width=device-width, initial-scale=1');
  assert.doesNotMatch(css, /(?:^|[;{])(?:width|min-width):100vw|(?:^|[;{])zoom:|transform:scale\(/);
  assert.doesNotMatch($('script').text(), /(?:window\.)?(?:parent|top)\.|frameElement/);
});

test('the portal stays top-aligned in tall viewports instead of using auto margins to vertically center the content', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8'), $ = load(html);
  const css = style(html);
  const shell = css.match(/(?:^|\n)\.shell\{([^}]+)\}/)?.[1];
  const main = css.match(/(?:^|\n)main\{([^}]+)\}/)?.[1];
  assert.ok(shell && main);
  assert.match(shell, /display:flex;flex-direction:column/);
  assert.doesNotMatch(shell, /justify-content:(?:center|space-around|space-evenly)/);
  assert.match(main, /(?:^|;)margin:0(?:;|$)/);
  assert.match(main, /(?:^|;)padding:2rem 0(?:;|$)/);
  assert.match(css, /@media\(max-width:640px\)\{\.shell\{padding:1\.25rem\}main\{padding:1\.5rem 0\}/);
  for (const [, rule] of css.matchAll(/main\{([^}]+)\}/g)) {
    assert.doesNotMatch(rule, /(?:^|;)(?:margin|margin-top|margin-bottom|margin-block(?:-start|-end)?):[^;]*\bauto\b/);
    assert.doesNotMatch(rule, /(?:^|;)(?:margin|padding)[^:]*:[^;]*(?:vh|dvh|svh|lvh)/);
  }
  assert.equal($('main').prev('header.masthead').length, 1, 'main must follow the masthead without a spacer');
});

test('the portal uses five distinct inline brand marks instead of letter placeholders', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8'), $ = load(html);
  assert.equal($('.monogram').length, 0);
  assert.equal($('.brand-mark').length, PROVIDERS.length);
  const shapes = [];
  for (const provider of PROVIDERS) {
    const card = $(`a[data-status-link="${provider}"]`), mark = card.find('.brand-mark'), svg = mark.find('svg');
    assert.equal(mark.attr('aria-hidden'), 'true');
    assert.equal(mark.text().trim(), '', 'the logo must not be a font-dependent letter');
    assert.equal(svg.length, 1);
    assert.equal(svg.attr('data-brand'), provider);
    const viewBoxes = { openai: '0 0 24 24', claude: '0 0 125 125', gemini: '0 0 192 192', deepseek: '0 0 27 23', kimi: '0 0 33 33' };
    assert.equal(svg.attr('viewBox'), viewBoxes[provider], 'keep official artwork proportions');
    assert.equal(svg.attr('focusable'), 'false');
    const paths = svg.find('path').map((_, node) => $(node).attr('d')).get().join(' ');
    assert.ok(paths.length > 100, `${provider} must retain actual official vector geometry`);
    shapes.push(paths);
  }
  assert.equal(new Set(shapes).size, PROVIDERS.length);
  assert.match(style(html), /\.brand-mark\{[^}]*color:var\(--text\)/);
  assert.match(style(html), /\.brand-mark svg\{[^}]*width:1\.75rem;height:1\.75rem/);
  assert.equal($('svg[data-brand="openai"]').attr('fill'), 'currentColor');
  assert.match(html, /Official-site brand artwork/);
  for (const source of ['https://developers.openai.com/', 'https://claude.com/', 'https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg', 'https://www.deepseek.com/', 'https://statics.kimi.ai/moonshot-ai/assets/static/moonshot-ai-wordmark.DeMGOuiG.svg']) assert.ok(html.includes(source));
  assert.doesNotMatch(html, /LobeHub|lobehub|raw\.githubusercontent/);
  assert.match(html, /Brand names and marks belong to their respective owners/);
});

test('brand marks contain no executable content, external assets or unresolved SVG references', () => {
  const $ = load(readFileSync(new URL('./index.html', import.meta.url), 'utf8'));
  const marks = $('.brand-mark');
  assert.equal(marks.find('script, foreignObject, iframe, style, text, animate, set').length, 0);
  const allowed = new Set(['svg', 'g', 'defs', 'path', 'rect', 'clipPath', 'radialGradient', 'linearGradient', 'stop', 'image']);
  marks.find('*').each((_, node) => {
    assert.ok(allowed.has(node.name), `unexpected SVG element ${node.name}`);
    for (const [name, value] of Object.entries(node.attribs || {})) {
      assert.doesNotMatch(name, /^on/i);
      assert.notEqual(name, 'style', 'SVG presentation must remain static attributes');
      if (name === 'href' || name === 'xlink:href') {
        if (node.name === 'image') {
          assert.match(value, /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/);
          const raw = Buffer.from(value.split(',')[1], 'base64');
          assert.ok(raw.length > 100 && raw.length < 100000);
          const isPng = raw.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
          assert.ok(isPng || (raw[0] === 255 && raw[1] === 216), 'only embedded raster images are allowed, never SVG or HTML data payloads');
        } else {
          assert.match(value, /^#[a-z0-9-]+$/);
          assert.equal($(value).length, 1, 'SVG references must resolve to one local element');
        }
      }
      if (value.startsWith('url(')) {
        assert.match(value, /^url\(#[a-z0-9-]+\)$/);
        assert.equal($(value.slice(4, -1)).length, 1);
      }
    }
  });
  const ids = $('[id]').map((_, node) => $(node).attr('id')).get();
  assert.equal(new Set(ids).size, ids.length);
  assert.equal($('script[src], link[href], img[src]').length, 0);
});

test('official artwork geometry, embedded Google image and theme variants remain inside one shared surface', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8'), $ = load(html);
  assert.ok($('svg[data-brand="openai"] path').attr('d').startsWith('M22.418 9.822'));
  assert.ok($('svg[data-brand="claude"] path').attr('d').startsWith('M54.375 118.75'));
  assert.equal($('svg[data-brand="claude"] path').attr('fill'), '#D97757');
  assert.ok($('svg[data-brand="deepseek"] g path').attr('d').startsWith('M26.5174 3.39471'));
  assert.equal($('svg[data-brand="deepseek"] g path').attr('fill'), 'currentColor');
  assert.match(style(html), /--brand-deepseek:#4176e6/);
  assert.match(style(html), /:root\[data-theme="dark"\]\{--brand-deepseek:#fff\}/);
  assert.equal($('svg[data-brand="gemini"] image').length, 1);
  assert.match($('svg[data-brand="gemini"] image').attr('href'), /^data:image\/jpeg;base64,/);
  assert.equal($('svg[data-brand="gemini"] defs').children().filter((_, n) => n.name === 'radialGradient').length, 1);
  assert.equal($('svg[data-brand="kimi"] image').length, 0);
  assert.equal($('svg[data-brand="kimi"] path').attr('fill'), 'currentColor');
  assert.ok($('svg[data-brand="kimi"] path').attr('d').startsWith('M28.8186 6.53439'));
  assert.doesNotMatch(html, /data-variant|official sidebar/);
  assert.deepEqual($('.card-heading > span:first-child').map((_, node) => $(node).attr('class')).get(), PROVIDERS.map(() => 'brand-mark'));
});

test('Kimi card retains the exact official Moonshot corporate symbol geometry selected by the user', () => {
  const $ = load(readFileSync(new URL('./index.html', import.meta.url), 'utf8'));
  const svg = $('svg[data-brand="kimi"]');
  assert.equal(svg.find('path').length, 1);
  assert.equal(svg.find('path').attr('fill-rule'), 'evenodd');
  assert.equal(svg.find('path').attr('clip-rule'), 'evenodd');
  assert.equal(createHash('sha256').update(svg.find('path').attr('d')).digest('hex'), '7ad897be108807ce5e684eaf8f108d597b5cbd46e395ca944548212c4495ffe8');
});

test('the portal carries only supported themes and never forwards tokens to any provider', () => {
  const js = script(readFileSync(new URL('./index.html', import.meta.url), 'utf8'));
  for (const theme of ['', 'light', 'dark', 'invalid', 'dark%3Btoken%3Dsecret']) {
    const links = PROVIDERS.map(provider => ({
      dataset: { statusLink: provider }, href: `./${provider}.html`,
      setAttribute(name, value) { assert.equal(name, 'href'); this.href = value; }
    }));
    const document = { documentElement: { dataset: {} }, querySelectorAll: selector => {
      assert.equal(selector, '[data-status-link]'); return links;
    } };
    runInNewContext(js, { URLSearchParams, location: { search: `?theme=${theme}&token=secret&access_token=secret&redirect=https://example.com` }, document });
    const suffix = ['light', 'dark'].includes(theme) ? `?theme=${theme}` : '';
    assert.equal(document.documentElement.dataset.theme, suffix ? theme : undefined);
    assert.deepEqual(links.map(link => link.href), PROVIDERS.map(provider => `./${provider}.html${suffix}`));
  }
});

function makeHarness(provider, extraIds = []) {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.className = ''; this.value = ''; this.tabIndex = 0; }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.value = ''; this.children = [...children]; }
    addEventListener(type, handler) { (this.listeners ||= {})[type] = handler; }
    focus() { this.listeners?.focus?.(); }
  }
  const baseIds = ['banner', 'banner-head', 'banner-body', 'notice', 'incidents', 'incident-list', 'rows', 'period', 'timestamp', 'refresh'];
  const nodes = Object.fromEntries([...baseIds, ...extraIds].map(id => [id, new Node('div')]));
  const document = { body: { dataset: { provider } }, documentElement: { dataset: {} },
    getElementById: id => nodes[id], createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), addEventListener() {} };
  const context = { document, URLSearchParams, location: { search: '', protocol: 'https:' }, matchMedia: () => ({ matches: false }),
    setInterval() {}, fetch: () => new Promise(() => {}), AbortSignal, Intl, Date };
  runInNewContext(script(page(provider)), context);
  return { nodes, context };
}

test('all providers preserve every valid official daily fill for every state and both themes', () => {
  const states = ['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance', 'official_history', 'unknown'];
  const colors = ['#1e8542', '#beaa2a', '#ed7532', '#e04343', '#2c84db', '#e5553b', '#b3bac5'];
  for (const provider of PROVIDERS) for (const theme of ['light', 'dark']) {
    const { context } = makeHarness(provider);
    context.document.documentElement.dataset.theme = theme;
    const track = context.bars({ name: 'Official component', days: states.map((state, i) => ({ state, color: colors[i], date: '2026-10-14', events: [] })) });
    assert.deepEqual(Array.from(track.children, bar => bar.style.backgroundColor), colors, provider + '/' + theme);
    assert.equal(track.children.filter(bar => bar.tabIndex === 0).length, 1);
    assert.match(track.children[0].title, /^2026-10-14 — Operational$/);
  }
});

test('daily fill validation rejects CSS payloads and non-string coercion without changing state', () => {
  for (const provider of PROVIDERS) {
    const { context } = makeHarness(provider);
    const invalid = ['url(https://example.invalid/pixel)', '#00ff00;opacity:0', 'var(--good)', '#fff', 'rgb(0,255,0)', '', null, {}, { toString() { throw new Error('must not coerce'); } }];
    const track = context.bars({ name: 'Official component', days: invalid.map(color => ({ state: 'unknown', color })) });
    assert.ok(track.children.every(bar => bar.style.backgroundColor === undefined));
    assert.ok(track.children.every(bar => bar.className === 'bar unknown'));
  }
});

function paletteRule(selector) {
  const css = style(page('openai')), start = css.indexOf(selector + '{');
  assert.ok(start >= 0, 'missing palette rule: ' + selector);
  return Object.fromEntries(css.slice(start + selector.length + 1, css.indexOf('}', start)).split(';').filter(Boolean).map(value => { const i = value.indexOf(':'); return [value.slice(0, i), value.slice(i + 1)]; }));
}

test('OpenAI light/dark and hover palettes match the statically verified official RGB variables', () => {
  const names = ['--good', '--yellow', '--orange', '--red', '--blue', '--history-empty'];
  const light = paletteRule('body[data-provider="openai"]'), dark = paletteRule(':root[data-theme="dark"] body[data-provider="openai"]');
  assert.deepEqual(names.map(name => light[name]), ['#24c19a', '#fbbf24', '#f5785c', '#f87171', '#3c82f6', '#f7f7f8']);
  assert.deepEqual(names.map(name => dark[name]), ['#1fa382', '#f59e0b', '#f25533', '#ef4444', '#2463eb', '#29292f']);
  const hover = ['--good-hover', '--yellow-hover', '--orange-hover', '--red-hover', '--blue-hover', '--history-empty-hover'];
  assert.deepEqual(hover.map(name => light[name]), ['#1fa382', '#f59e0b', '#f25533', '#ef4444', '#2463eb', '#e4e4e7']);
  assert.deepEqual(hover.map(name => dark[name]), ['#187f65', '#d97706', '#dd340e', '#dc2625', '#1c4ed8', '#39393f']);
});

test('Claude, DeepSeek and Kimi keep distinct official state palettes rather than shared approximate colors', () => {
  const palettes = { claude: ['#76ad2a', '#faa72a', '#e86235', '#e04343', '#2c84db'], deepseek: ['#22c55e', '#eab308', '#f97316', '#ef4444', '#3b82f6'], kimi: ['#1e8542', '#f1c40f', '#b35e14', '#de2f1b', '#207ab6'] };
  for (const [provider, expected] of Object.entries(palettes)) {
    const rule = paletteRule('body[data-provider="' + provider + '"]');
    assert.deepEqual(['--good', '--yellow', '--orange', '--red', '--blue'].map(name => rule[name]), expected);
  }
  assert.equal(paletteRule('body[data-provider="deepseek"]')['--history-empty'], 'hsl(0 0% 45.1% / .15)');
  assert.equal(paletteRule(':root[data-theme="dark"] body[data-provider="deepseek"]')['--history-empty'], 'hsl(0 0% 63.9% / .15)');
  assert.equal(paletteRule('body[data-provider="kimi"]')['--history-empty'], '#b3bac5');
  assert.doesNotMatch(style(page('openai')), /\.bar:hover,\.bar:focus\{[^}]*opacity:/, 'opacity must not recolor official fills');
});

test('incident severity separates partial outage, full outage and maintenance while Gemini keeps its own major meaning', () => {
  for (const provider of PROVIDERS) {
    const { context } = makeHarness(provider);
    for (const [impact, expected] of [['minor', 'degraded_performance'], ['major', provider === 'gemini' ? 'major_outage' : 'partial_outage'], ['critical', 'major_outage'], ['maintenance', 'under_maintenance'], ['none', 'unknown']]) {
      const article = context.incidentCard({ name: 'Official issue', status: 'investigating', impact });
      assert.equal(article.children[0].children[0].attributes['data-state'], expected, provider + '/' + impact);
    }
  }
});

test('summary indicators preserve partial versus full outage and never promote unknown vocabulary to operational', () => {
  for (const provider of PROVIDERS) {
    const { context, nodes } = makeHarness(provider);
    for (const [indicator, expected] of [['none', 'operational'], ['minor', 'degraded_performance'], ['major', provider === 'gemini' ? 'major_outage' : 'partial_outage'], ['critical', 'major_outage'], ['maintenance', 'under_maintenance'], ['__proto__', 'unknown']]) {
      context.render({ provider, fetchedAt: '2026-10-14T00:00:00Z', status: { indicator, description: 'Official report' }, components: [], incidents: [], history: { available: false } });
      assert.equal(nodes['banner-head'].children[0].attributes['data-state'], expected, provider + '/' + indicator);
    }
    context.render({ error: 'Offline' });
    assert.equal(nodes.banner.className, 'banner unknown');
    assert.equal(nodes['banner-head'].children.length, 0);
  }
});

test('state-specific icon and banner colors distinguish maintenance blue and partial-outage orange', () => {
  const css = style(page('openai'));
  assert.match(css, /\.status-icon\[data-state="partial_outage"\]\{color:var\(--orange\)\}/);
  assert.match(css, /\.status-icon\[data-state="under_maintenance"\]\{color:var\(--blue,#60a5fa\)\}/);
  assert.match(css, /\.banner\.bad:has\(\.status-icon\[data-state="partial_outage"\]\)\{border-color:var\(--orange\)\}/);
  assert.match(css, /\.banner\.warn:has\(\.status-icon\[data-state="under_maintenance"\]\)\{border-color:var\(--blue,#60a5fa\)\}/);
  assert.match(css, /\.banner\.bad:not\(\.incident\)/, 'overview tint must not override the neutral incident header surface');
});

// A wall-clock local time in the runner's own timezone, so the chart's local
// calendar-day maths can be asserted without depending on the host timezone.
const localIso = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s, 0).toISOString();

function geminiData() {
  const fetched = localIso(2026, 10, 13, 12, 0);
  return {
    provider: 'gemini', fetchedAt: fetched, stale: false, incidentsAvailable: true,
    status: { indicator: 'none', description: 'No active incidents reported' },
    components: [{ id: '1', name: 'API', status: 'operational' }, { id: '2', name: 'Multimodal Live API', status: 'operational' }, { id: '3', name: 'Google AI Studio', status: 'operational' }],
    incidents: [],
    history: {
      available: true, stale: false, fetchedAt: fetched, snapshotKind: 'official-incident-feed',
      rangeLabel: 'Official incident history',
      rows: [
        { id: '1', name: 'API', status: 'operational', uptime: null, days: [], components: [] },
        { id: '2', name: 'Multimodal Live API', status: 'operational', uptime: null, days: [], components: [] },
        { id: '3', name: 'Google AI Studio', status: 'operational', uptime: null, days: [], components: [] }
      ],
      incidents: [], metricsNote: 'The official incident feed does not provide published uptime percentages. These metrics have not been estimated.',
      chartIncidents: [],
      recentIncidents: [
        { id: 'a1', name: 'Elevated errors in the API', status: 'resolved', impact: 'minor', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T02:00:00Z', body: 'Resolved after a fix was deployed.', affectedComponents: ['API'] },
        { id: 'a2', name: 'Degraded performance in AI Studio', status: 'monitoring', impact: 'major', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T03:00:00Z', body: 'Monitoring recovery.', affectedComponents: ['Google AI Studio'] }
      ],
      overall: { status: 'operational', title: 'No active incidents reported', description: 'Reported by the official Gemini API and Google AI Studio incident feed. This is not an active probe of your account or channel.' }
    }
  };
}

test('the new Gemini containers render a neutral metrics note and recent incidents', () => {
  const { nodes, context } = makeHarness('gemini', ['metrics-note', 'recent', 'recent-list', 'recent-note']);
  context.render(geminiData());
  assert.equal(nodes['metrics-note'].hidden, false);
  assert.match(nodes['metrics-note'].textContent, /not been estimated/);
  assert.equal(nodes.recent.hidden, false);
  assert.equal(nodes['recent-list'].children.length, 2);
  assert.match(nodes.rows.textContent, /API/);
  assert.doesNotMatch(nodes.rows.textContent, /% uptime|bar /, 'components without daily history must not fabricate bars or percentages');
  assert.doesNotMatch(nodes.notice.textContent, /uptime data has been estimated/);
});

test('recent resolved incidents are neutral and are never shown as a current outage', () => {
  const { nodes, context } = makeHarness('gemini', ['metrics-note', 'recent', 'recent-list', 'recent-note']);
  context.render(geminiData());
  const resolved = nodes['recent-list'].children[0];
  assert.match(resolved.className, /resolved/);
  assert.match(resolved.className, /banner incident unknown/);
  assert.doesNotMatch(resolved.className, /bad|good/);
  assert.match(resolved.textContent, /Resolved/);
  assert.doesNotMatch(resolved.textContent, /Ongoing/);
  assert.equal(nodes.incidents.hidden, true, 'resolved history must not become a live incident card');
  assert.equal(nodes['incident-list'].children.length, 0);
});

test('an active recent incident keeps its real severity and is not neutral, and mitigated is not resolved', () => {
  const { nodes, context } = makeHarness('gemini', ['metrics-note', 'recent', 'recent-list', 'recent-note']);
  const data = geminiData();
  data.history.recentIncidents[1].status = 'mitigated';
  context.render(data);
  const active = nodes['recent-list'].children[1];
  assert.match(active.className, /bad/);
  assert.match(active.textContent, /Mitigated/);
  assert.doesNotMatch(active.className, /resolved/);
  assert.doesNotMatch(nodes['recent-list'].children[0].className, /Mitigated/);
});

test('providers without recentIncidents or a metrics note hide those containers completely', () => {
  const { nodes, context } = makeHarness('gemini', ['metrics-note', 'recent', 'recent-list', 'recent-note']);
  const data = geminiData();
  delete data.history.recentIncidents; delete data.history.metricsNote;
  context.render(data);
  assert.equal(nodes.recent.hidden, true);
  assert.equal(nodes['recent-list'].children.length, 0);
  assert.equal(nodes['metrics-note'].hidden, true);
  assert.equal(nodes['metrics-note'].textContent, '');
});

test('a cold failure clears the recent-incident UI and a later stale response labels the old list', () => {
  const { nodes, context } = makeHarness('gemini', ['metrics-note', 'recent', 'recent-list', 'recent-note']);
  context.render(geminiData());
  assert.equal(nodes.recent.hidden, false);
  context.render({ error: 'Unable to fetch official status data.' });
  assert.equal(nodes.recent.hidden, true);
  assert.equal(nodes['recent-list'].children.length, 0);
  assert.equal(nodes['metrics-note'].hidden, true);
  const stale = geminiData(); stale.stale = true; stale.error = 'Refresh failed. Showing previously fetched official data.';
  context.render(stale);
  assert.equal(nodes.recent.hidden, false);
  assert.equal(nodes['recent-note'].hidden, false);
  assert.match(nodes['recent-note'].textContent, /may be out of date/);
});

test('the unified logic still runs when only the original container IDs exist', () => {
  // The pre-existing OpenAI/Claude fixtures expose just these IDs; the new
  // containers must be reached through optional lookups so nothing throws.
  const { nodes, context } = makeHarness('openai');
  assert.doesNotThrow(() => context.render(geminiData()));
  assert.match(nodes.rows.textContent, /API/);
  assert.equal(nodes.recent, undefined);
});

test('the new containers exist in every provider page and stay empty until data arrives', () => {
  for (const provider of PROVIDERS) {
    const html = page(provider);
    for (const id of ['metrics-note', 'recent', 'recent-list', 'recent-note']) {
      assert.match(html, new RegExp(`id="${id}"`), `${provider} must include #${id}`);
    }
    assert.match(html, /<h2>Recent incidents<\/h2>/);
    assert.match(html, /id="recent" hidden/);
    assert.match(html, /id="metrics-note" hidden/);
  }
});

test('the history timestamp distinguishes the official incident feed from HTML snapshots', () => {
  const js = script(page('gemini'));
  assert.match(js, /snapshotKind==='official-html'\?'Official HTML snapshot: '/);
  assert.match(js, /snapshotKind==='official-incident-feed'\?'Official incident feed: '/);
  assert.match(js, /provider==='openai'\?'Official HTML snapshot: ':'Official history snapshot: '/);
});

test('Kimi official mixed and unavailable colors are preserved without unsafe style input', () => {
  const { context, nodes } = makeHarness('kimi');
  const data = geminiData(); data.history.rows = [{name:'Open API',status:'operational',uptime:'99.94',components:[],days:[{state:'official_history',color:'#da9e11',date:'2026-10-13'},{state:'unknown',color:'#b3bac5'},{state:'official_history',color:'url(javascript:alert(1))'}]}];
  context.render(data); const bars = nodes.rows.children[0].children[1].children;
  assert.equal(bars[0].style.backgroundColor,'#da9e11'); assert.equal(bars[1].style.backgroundColor,'#b3bac5'); assert.equal(bars[2].style.backgroundColor,undefined);
  assert.match(bars[0].title,/Official chart color/); assert.equal(bars.length,3);
});

test('Gemini stale or history-disabled views retain reported status wording, not probed health claims', () => {
  const { context, nodes } = makeHarness('gemini');
  const data=geminiData(); data.stale=true; context.render(data);
  assert.match(nodes['banner-head'].textContent,/No active incidents reported/); assert.doesNotMatch(nodes['banner-head'].textContent,/fully operational/);
  data.history={available:false,error:'Historical data is unavailable.'}; context.render(data);
  assert.match(nodes['banner-head'].textContent,/No active incidents reported/); assert.match(nodes['banner-body'].textContent,/not an active probe/);
});

test('fresh summary overrides stale historical component states in both directions without modifying metrics or bars', () => {
  for (const [fresh,old] of [['operational','major_outage'],['major_outage','operational']]) {
    const {context,nodes}=makeHarness('kimi'); const data=geminiData(); data.components=[{id:'api',name:'Open API',status:fresh}];
    data.history.stale=true; data.history.error='History refresh failed.'; data.history.rows=[{id:'api',name:'Open API',status:old,uptime:'99.94',days:[{state:old}],components:[]}];
    const original=JSON.stringify(data); context.render(data);
    const row=nodes.rows.children[0]; assert.match(row.children[0].textContent,new RegExp(fresh==='operational'?'Operational':'Major Outage'));
    assert.equal(row.children[0].children[0].attributes.class,'status-icon '+(fresh==='operational'?'good':'bad'));
    assert.equal(row.children[1].children[0].className,'bar '+old); assert.match(row.textContent,/99\.94% uptime/); assert.equal(JSON.stringify(data),original);
  }
});

test('stale group state uses current official group status; unmatched stale rows become unknown', () => {
  const {context,nodes}=makeHarness('kimi'); const data=geminiData(); data.groups=[{id:'group',name:'Kimi Code',status:'major_outage'}];
  data.history.stale=true; data.history.rows=[{id:'group',name:'Kimi Code',status:'operational',components:[],days:[],uptime:null},{id:'retired',name:'Retired component',status:'operational',components:[],days:[],uptime:null}];
  context.render(data); assert.equal(nodes.rows.children[0].children[0].children[0].attributes.class,'status-icon bad'); assert.equal(nodes.rows.children[1].children[0].children[0].attributes.class,'status-icon unknown');
});

test('Kimi title-language disclosure remains in active cards even when history fails or the body is English', () => {
  const {context,nodes}=makeHarness('kimi'); const data=geminiData();
  data.incidents=[{id:'one',name:'Official incident one',status:'investigating',impact:'minor',body:'Investigating.',originalLanguageNote:'Original update is not published in English; it has not been translated.'}]; data.history={available:false,error:'History unavailable'};
  context.render(data); assert.match(nodes['incident-list'].textContent,/not been translated/);
});

test('every subpage header embeds the exact official portal logo without runtime requests', () => {
  const portal = load(readFileSync(new URL('./index.html', import.meta.url), 'utf8'));
  for (const provider of PROVIDERS) {
    const html = page(provider), $ = load(html), mark = $('.header .brand-mark');
    assert.equal(mark.length, 1);
    assert.equal(mark.attr('aria-hidden'), 'true');
    assert.equal(mark.find('svg').attr('data-brand'), provider);
    assert.equal(mark.find('svg').toString(), portal(`svg[data-brand="${provider}"]`).toString(), 'exact official artwork must be shared across the portal and subpage');
    assert.equal($('.brand-heading .brand-copy h1').length, 1);
    assert.match(html, /Official-site brand artwork/);
    assert.equal(mark.find('script, foreignObject, style, text').length, 0);
    const ids = $('[id]').map((_, node) => $(node).attr('id')).get();
    assert.equal(new Set(ids).size, ids.length);
    mark.find('*').each((_, node) => {
      for (const [name, value] of Object.entries(node.attribs || {})) {
        assert.doesNotMatch(name, /^on/i);
        assert.notEqual(name, 'style');
        if (name === 'href' || name === 'xlink:href') {
          assert.match(value, node.name === 'image' ? /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/ : /^#[a-z0-9-]+$/);
          if (node.name !== 'image') assert.equal($(value).length, 1);
        }
        if (value.startsWith('url(')) assert.equal($(value.slice(4, -1)).length, 1);
      }
    });
    assert.match(style(html), /:root\[data-theme="dark"\] \.brand-mark svg\[data-brand="deepseek"\]\{color:#fff\}/);
  }
});

// ===========================================================================
// Gemini official 90-day daily chart
// ===========================================================================

const chartIds = ['system-title', 'timeline-note', 'timeline-legend', 'metrics-note', 'recent', 'recent-list', 'recent-note'];
const chartCells = row => row.children.find(node => node.className === 'incident-track')?.children;

function chartStart() {
  const anchor = new Date(localIso(2026, 10, 13, 12, 0));
  anchor.setHours(0, 0, 0, 0);
  const start = new Date(anchor);
  start.setDate(start.getDate() - 89);
  return start;
}
function dayIndex(y, m, d) {
  const start = chartStart();
  return (Date.UTC(y, m - 1, d) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000;
}

test('Gemini draws the official 90-day daily chart automatically for every known tier', () => {
  const { context, nodes } = makeHarness('gemini', chartIds);
  const data = geminiData(), before = JSON.stringify(data);
  context.render(data);
  assert.equal(nodes['system-title'].textContent, 'System status');
  assert.equal(nodes['timeline-note'].hidden, false);
  assert.equal(nodes['timeline-legend'].hidden, false);
  assert.equal(nodes.rows.children.length, 3);
  for (const row of nodes.rows.children) {
    assert.equal(chartCells(row).length, 90, 'every tier must show all 90 local calendar days');
    assert.equal(row.children.filter(node => node.className === 'bars').length, 0);
    assert.doesNotMatch(row.textContent, /% uptime/);
  }
  assert.equal(JSON.stringify(data), before, 'rendering must not modify the official payload');
  assert.equal(nodes.incidents.hidden, true, 'the chart does not override current incident state');
  const $ = load(page('gemini'));
  assert.equal($('.system #timeline-note').length, 1);
  assert.equal($('.system #timeline-legend').length, 1);
  assert.match($('#timeline-note').text(), /All tiers/);
  assert.match($('#timeline-note').text(), /90 local calendar days/);
  assert.match($('#timeline-note').text(), /green is not measured uptime/);
});

test('the daily chart is Gemini-only, marks unknown tiers and never fabricates a green default', () => {
  for (const provider of ['openai', 'claude', 'deepseek', 'kimi']) {
    const { context, nodes } = makeHarness(provider, chartIds);
    context.render(geminiData());
    assert.equal(nodes['timeline-note'].hidden, true, `${provider} must not show the Gemini chart note`);
    assert.equal(nodes['timeline-legend'].hidden, true);
    assert.equal(nodes.rows.children.every(row => !chartCells(row)), true);
  }
  const { context, nodes } = makeHarness('gemini', chartIds);
  const data = geminiData();
  data.history.rows.push({ id: '9', name: 'New tier', status: 'operational', uptime: null, days: [], components: [] });
  context.render(data);
  assert.equal(nodes.rows.children.length, 4, 'an unknown tier must still be listed explicitly');
  assert.equal(chartCells(nodes.rows.children[0]).length, 90);
  assert.equal(chartCells(nodes.rows.children[3]), undefined, 'only the three known tiers get an official chart');
  assert.match(nodes.rows.children[3].textContent, /daily chart is not available for this tier/);
});

test('the chart uses exactly the three official MakerSuite colors', () => {
  const css = style(page('gemini'));
  assert.match(css, /\.incident-day\{[^}]*background:#1abd74/);
  assert.match(css, /\.incident-day\.moderate\{background:#ffb95c\}/);
  assert.match(css, /\.incident-day\.major\{background:#ff2a6a\}/);
  const rules = [...css.matchAll(/\.(?:incident-day|legend-swatch)[^{]*\{[^}]*\}/g)].map(([rule]) => rule);
  const colors = new Set(rules.flatMap(rule => [...rule.matchAll(/#[0-9a-f]{6}/gi)].map(match => match[0].toLowerCase())));
  assert.deepEqual([...colors].sort(), ['#1abd74', '#ff2a6a', '#ffb95c']);
  assert.equal(colors.has('#20c997'), false, 'the chart must not reuse the generic page green');
  const data = geminiData();
  data.history.chartIncidents = [
    { id: 'm', name: 'Moderate issue', status: 'resolved', impact: 'minor', startedAt: localIso(2026, 10, 5, 9, 0), endedAt: localIso(2026, 10, 5, 10, 0), affectedComponents: ['API'] },
    { id: 'M', name: 'Major issue', status: 'resolved', impact: 'major', startedAt: localIso(2026, 10, 6, 9, 0), endedAt: localIso(2026, 10, 6, 10, 0), affectedComponents: ['API'] }
  ];
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(data);
  const cells = chartCells(nodes.rows.children[0]);
  assert.equal(cells[dayIndex(2026, 10, 5)].className, 'incident-day moderate');
  assert.equal(cells[dayIndex(2026, 10, 6)].className, 'incident-day major');
  assert.equal(cells[dayIndex(2026, 10, 7)].className, 'incident-day');
  assert.equal(new Set(cells.map(cell => cell.className)).size, 3);
});

test('a day is colored only when its clipped interval rounds up to one whole minute', () => {
  const data = geminiData();
  data.history.chartIncidents = [
    { id: 'edge', name: 'Midnight crossing', status: 'resolved', impact: 'minor', startedAt: localIso(2026, 10, 9, 23, 59, 45), endedAt: localIso(2026, 10, 10, 0, 0, 30), affectedComponents: ['API'] },
    { id: 'short', name: 'Short blip', status: 'resolved', impact: 'major', startedAt: localIso(2026, 10, 11, 12, 0, 0), endedAt: localIso(2026, 10, 11, 12, 0, 29), affectedComponents: ['API'] }
  ];
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(data);
  const cells = chartCells(nodes.rows.children[0]);
  assert.equal(cells[dayIndex(2026, 10, 9)].className, 'incident-day', 'under 30 seconds rounds down to no coverage');
  assert.equal(cells[dayIndex(2026, 10, 10)].className, 'incident-day moderate', 'exactly 30 seconds rounds up to one whole minute');
  assert.equal(cells[dayIndex(2026, 10, 11)].className, 'incident-day', '29 seconds rounds down to no coverage');
  assert.match(cells[dayIndex(2026, 10, 10)].title, /Resolved/);
});

test('the chart stays anchored to the fetched snapshot when the page is stale', () => {
  const data = geminiData();
  data.history.chartIncidents = [{ id: 'e', name: 'Published outage', status: 'resolved', impact: 'major', startedAt: localIso(2026, 10, 12, 10, 0), endedAt: localIso(2026, 10, 12, 11, 0), affectedComponents: ['API'] }];
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(data);
  const period = nodes.period.textContent, before = chartCells(nodes.rows.children[0]).map(cell => cell.className);
  assert.match(period, /\(local time\)$/);
  data.stale = true; data.error = 'Connection failed. Showing previously fetched official data.';
  data.fetchedAt = localIso(2026, 11, 1, 9, 0);
  context.render(data);
  assert.equal(nodes.period.textContent, period, 'a stale snapshot must not drift to the wall clock');
  assert.deepEqual(chartCells(nodes.rows.children[0]).map(cell => cell.className), before);
  assert.equal(chartCells(nodes.rows.children[0]).length, 90);
  assert.match(nodes.notice.textContent, /Connection failed/);
});

test('an ongoing incident covers the snapshot day and an early start still covers the window', () => {
  const ongoing = geminiData();
  ongoing.history.chartIncidents = [{ id: 'long', name: 'Ongoing outage', status: 'monitoring', impact: 'major', startedAt: localIso(2026, 7, 1, 0, 0), endedAt: null, affectedComponents: ['API'] }];
  const first = makeHarness('gemini', chartIds);
  first.context.render(ongoing);
  const cells = chartCells(first.nodes.rows.children[0]);
  assert.equal(cells.length, 90);
  assert.equal(cells.every(cell => cell.className === 'incident-day major'), true, 'an interval that started before the window still covers it');
  assert.match(cells.at(-1).title, /ongoing/);
  assert.equal(chartCells(first.nodes.rows.children[1]).every(cell => cell.className === 'incident-day'), true, 'other tiers stay uncolored');

  const bounded = geminiData();
  bounded.history.chartIncidents = [{ id: 'early', name: 'Early outage', status: 'resolved', impact: 'major', startedAt: localIso(2026, 7, 1, 0, 0), endedAt: localIso(2026, 8, 1, 12, 0), affectedComponents: ['API'] }];
  const second = makeHarness('gemini', chartIds);
  second.context.render(bounded);
  const boundedCells = chartCells(second.nodes.rows.children[0]);
  assert.equal(boundedCells[dayIndex(2026, 7, 16)].className, 'incident-day major', 'the first in-window day is covered');
  assert.equal(boundedCells[dayIndex(2026, 8, 1)].className, 'incident-day major', 'the clipped final day is covered');
  assert.equal(boundedCells[dayIndex(2026, 8, 2)].className, 'incident-day', 'days after the interval end are not covered');
});

test('a valid empty feed renders 90 green days labelled as no recorded issue', () => {
  const { context, nodes } = makeHarness('gemini', chartIds);
  const data = geminiData(); data.history.chartIncidents = [];
  context.render(data);
  const cells = chartCells(nodes.rows.children[0]);
  assert.equal(cells.length, 90);
  assert.equal(cells.every(cell => cell.className === 'incident-day'), true);
  assert.match(cells[0].title, /No issues recorded on this day/);
  assert.match(cells[0].title, /not a measured uptime probe/);
  assert.doesNotMatch(cells[0].title, /% uptime/);
});

test('malformed, impossible or future chart intervals fail closed instead of drawing green days', () => {
  const cases = {
    'unparsable start': { startedAt: 'not a date', endedAt: null },
    'unparsable end': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: 'not a date' },
    'end before start': { startedAt: localIso(2026, 10, 11, 1, 0), endedAt: localIso(2026, 10, 10, 1, 0) },
    'start after the snapshot': { startedAt: localIso(2026, 10, 20, 1, 0), endedAt: null },
    'end after the snapshot': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: localIso(2026, 10, 20, 1, 0) },
    'missing endedAt': { startedAt: localIso(2026, 10, 10, 1, 0) },
    'missing components': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: null, affectedComponents: undefined },
    'missing severity': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: null, impact: undefined },
    'unknown severity': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: null, impact: 'none' },
    'empty scope': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: null, affectedComponents: [] },
    'non-string scope': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: null, affectedComponents: [7] },
    'blank scope name': { startedAt: localIso(2026, 10, 10, 1, 0), endedAt: null, affectedComponents: [''] }
  };
  for (const [name, bad] of Object.entries(cases)) {
    const data = geminiData();
    data.history.chartIncidents = [{ id: 'bad', name: 'Bad record', status: 'resolved', impact: 'minor', affectedComponents: ['API'], ...bad }];
    const { context, nodes } = makeHarness('gemini', chartIds);
    context.render(data);
    assert.equal(nodes['timeline-note'].hidden, true, `${name} must not show the chart note`);
    assert.equal(nodes['timeline-legend'].hidden, true, `${name} must not show the legend`);
    assert.equal(nodes.rows.children.every(row => !chartCells(row)), true, `${name} must not draw any green default`);
    assert.equal(nodes.period.textContent, 'Daily history unavailable', `${name} must say the daily history is unavailable`);
    assert.match(nodes.notice.textContent, /daily chart data is missing or invalid/, `${name} must explain the missing chart`);
  }
});

test('a missing chartIncidents array or an invalid snapshot date fails closed without a green default', () => {
  for (const mutate of [data => { delete data.history.chartIncidents; }, data => { data.history.fetchedAt = 'not a date'; }]) {
    const data = geminiData();
    data.history.timelineIncidents = [{ id: 'legacy', name: 'Legacy record', status: 'resolved', impact: 'major', createdAt: localIso(2026, 10, 10, 9, 0), affectedComponents: ['API'] }];
    mutate(data);
    const { context, nodes } = makeHarness('gemini', chartIds);
    context.render(data);
    assert.equal(nodes.rows.children.every(row => !chartCells(row)), true, 'the legacy timeline field must never be drawn');
    assert.equal(nodes['timeline-note'].hidden, true);
    assert.equal(nodes['timeline-legend'].hidden, true);
    assert.equal(nodes.period.textContent, 'Daily history unavailable');
    assert.match(nodes.notice.textContent, /daily chart data is missing or invalid/);
  }
});

test('a Gemini feed with a missing or invalid snapshotKind fails closed instead of looking normal', () => {
  for (const kind of [undefined, null, 7, '']) {
    const data = geminiData();
    if (kind === undefined) delete data.history.snapshotKind; else data.history.snapshotKind = kind;
    const { context, nodes } = makeHarness('gemini', chartIds);
    context.render(data);
    assert.equal(nodes.rows.children.every(row => !chartCells(row)), true, `snapshotKind=${String(kind)} must not draw cells`);
    assert.equal(nodes['timeline-note'].hidden, true);
    assert.equal(nodes['timeline-legend'].hidden, true);
    assert.equal(nodes.period.textContent, 'Daily history unavailable');
    assert.match(nodes.notice.textContent, /daily chart data is missing or invalid/);
  }
});

test('a non-Gemini-feed snapshot draws no chart and never claims the daily history is broken', () => {
  const data = geminiData();
  data.history.timelineIncidents = [{ id: 'legacy', name: 'Legacy record', status: 'resolved', impact: 'major', createdAt: localIso(2026, 10, 10, 9, 0), affectedComponents: ['API'] }];
  data.history.snapshotKind = 'official-html';
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(data);
  assert.equal(nodes.rows.children.every(row => !chartCells(row)), true);
  assert.equal(nodes['timeline-note'].hidden, true);
  assert.equal(nodes.period.textContent, 'Official incident history');
  assert.doesNotMatch(nodes.notice.textContent, /daily chart data is missing or invalid/);
});

test('a cold failure clears the chart, its period, note and legend', () => {
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(geminiData());
  assert.equal(nodes['timeline-note'].hidden, false);
  context.render({ error: 'Unable to connect to the status service. Please try again.' });
  assert.equal(nodes['timeline-note'].hidden, true);
  assert.equal(nodes['timeline-legend'].hidden, true);
  assert.equal(nodes['system-title'].textContent, 'System status');
  assert.equal(nodes.period.textContent, 'History unavailable');
  assert.match(nodes.rows.textContent, /No official history data/);
});

test('day buttons expose safe literal text with one Tab entry and arrow-key roving focus', () => {
  const data = geminiData();
  data.history.chartIncidents = [{ id: 'x', name: '<img src=x onerror=alert(1)>', status: 'resolved', impact: 'minor', startedAt: localIso(2026, 10, 10, 9, 0), endedAt: localIso(2026, 10, 10, 10, 0), affectedComponents: ['API'] }];
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(data);
  const row = nodes.rows.children[0], cells = chartCells(row), detail = row.children.find(node => node.className === 'day-detail');
  const cell = cells[dayIndex(2026, 10, 10)];
  cell.listeners.click();
  assert.match(detail.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(detail.textContent, /Resolved/);
  assert.equal(detail.children.length, 0, 'untrusted incident titles must remain text');
  assert.equal(cells.filter(node => node.tabIndex === 0).length, 1);
  assert.equal(cell.attributes.type, 'button');
  assert.ok(cell.attributes['aria-label']);
  let prevented = false; cells[0].nextElementSibling = cells[1];
  cells[0].listeners.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(cells[0].tabIndex, -1); assert.equal(cells[1].tabIndex, 0);
  assert.equal(detail.textContent, cells[1].title);
});

test('pointer selection and programmatic focus retain exactly one Tab entry before and after arrow navigation', () => {
  const { context, nodes } = makeHarness('gemini', chartIds);
  context.render(geminiData());
  const cells = chartCells(nodes.rows.children[0]);
  const single = () => cells.map((cell, index) => cell.tabIndex === 0 ? index : -1).filter(index => index >= 0);
  cells[77].listeners.click();
  assert.deepEqual(single(), [77]);
  cells[77].nextElementSibling = cells[78];
  cells[77].listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.deepEqual(single(), [78]);
  cells[40].focus();
  assert.deepEqual(single(), [40]);
  cells[40].previousElementSibling = cells[39];
  cells[40].listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(single(), [39]);
});

test('other providers keep their original official daily bars and never receive the Gemini chart', () => {
  for (const provider of ['openai', 'claude', 'deepseek', 'kimi']) {
    const { context, nodes } = makeHarness(provider, chartIds);
    const data = geminiData();
    data.history.rows[0].days = [{ state: 'operational', date: '2026-10-12' }];
    data.history.rows[0].uptime = '99.95';
    context.render(data);
    assert.equal(nodes['system-title'].textContent, 'System status');
    assert.equal(nodes['timeline-note'].hidden, true);
    assert.match(nodes.rows.children[0].textContent, /99.95% uptime/);
    assert.equal(nodes.rows.children[0].children[1].children[0].className, 'bar operational');
    assert.equal(nodes.rows.children.every(row => !chartCells(row)), true);
  }
});

// The chart resolves local calendar days, so the +8 and DST cases run in a child
// process pinned to a specific timezone instead of depending on the runner's TZ.
const CHILD = [
  "import { readFileSync } from 'node:fs';",
  "import { runInNewContext } from 'node:vm';",
  "import { load } from 'cheerio';",
  "class Node { constructor(tag){ this.tagName=tag; this.children=[]; this.attributes={}; this.dataset={}; this.style={}; this.hidden=false; this.className=''; this.value=''; this.tabIndex=0; } set textContent(v){ this.value=String(v); this.children=[]; } get textContent(){ return this.value+this.children.map(c=>c.textContent).join(''); } setAttribute(n,v){ this.attributes[n]=String(v); if(n==='class') this.className=String(v); } append(...c){ this.children.push(...c); } replaceChildren(...c){ this.value=''; this.children=[...c]; } addEventListener(t,h){ (this.listeners||={})[t]=h; } focus(){ this.listeners?.focus?.(); } }",
  "const ids=['banner','banner-head','banner-body','notice','incidents','incident-list','rows','period','timestamp','refresh','system-title','timeline-note','timeline-legend'];",
  "const nodes=Object.fromEntries(ids.map(id=>[id,new Node('div')]));",
  "const document={ body:{dataset:{provider:'gemini'}}, documentElement:{dataset:{}}, getElementById:id=>nodes[id], createElement:t=>new Node(t), createElementNS:(_,t)=>new Node(t), addEventListener(){} };",
  "const context={ document, URLSearchParams, location:{search:'',protocol:'https:'}, matchMedia:()=>({matches:false}), setInterval(){}, fetch:()=>new Promise(()=>{}), AbortSignal, Intl, Date };",
  "runInNewContext(load(readFileSync(process.env.PAGE,'utf8'))('script').text(), context);",
  "const fetchedAt=process.env.FETCHED;",
  "context.render({ provider:'gemini', fetchedAt, stale:false, incidentsAvailable:true, status:{indicator:'none',description:'No active incidents reported'}, components:[], incidents:[], history:{ available:true, stale:false, fetchedAt, snapshotKind:'official-incident-feed', rangeLabel:'Official incident history', rows:[{id:'1',name:'API',status:'operational',uptime:null,days:[],components:[]}], incidents:[], chartIncidents:JSON.parse(process.env.EVENTS) } });",
  "const cells=nodes.rows.children[0].children.find(n=>n.className==='incident-track').children;",
  "console.log(JSON.stringify({ labels: cells.map(c=>c.title.split(' \\u2014 ')[0]), classes: cells.map(c=>c.className) }));"
].join('\n');

function runChartChild(tz, fetchedAt, events) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: { ...process.env, TZ: tz, PAGE: fileURLToPath(new URL('./gemini.html', import.meta.url)), FETCHED: fetchedAt, EVENTS: JSON.stringify(events) },
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

test('a +8 host keeps an event that crosses local midnight on the correct local day', () => {
  const result = runChartChild('Asia/Shanghai', '2026-10-13T04:00:00.000Z', [
    { id: 'midnight', name: 'Midnight crossing', status: 'resolved', impact: 'minor', startedAt: '2026-10-09T16:30:00.000Z', endedAt: '2026-10-09T16:45:00.000Z', affectedComponents: ['API'] }
  ]);
  assert.equal(result.labels.length, 90);
  assert.equal(result.labels.at(-1), '13 Oct 2026');
  assert.equal(result.labels.indexOf('10 Oct 2026'), dayIndex(2026, 10, 10), 'local dates must match the runner-side expectation');
  assert.equal(result.classes[result.labels.indexOf('10 Oct 2026')], 'incident-day moderate', '00:30 local belongs to the local day, not the UTC day');
  assert.equal(result.classes[result.labels.indexOf('09 Oct 2026')], 'incident-day');
});

test('a window spanning a DST change still yields 90 distinct local calendar days', () => {
  const result = runChartChild('America/New_York', '2026-11-16T17:00:00.000Z', []);
  assert.equal(result.labels.length, 90);
  assert.equal(new Set(result.labels).size, 90, 'setDate must not duplicate or skip a DST day');
  assert.equal(result.labels[0], '19 Aug 2026');
  assert.equal(result.labels.at(-1), '16 Nov 2026');
  assert.equal(result.labels.includes('01 Nov 2026'), true);
  assert.equal(Date.parse(result.labels.at(-1)) - Date.parse(result.labels[0]), 89 * 86400000);
});

test('a Santiago spring-forward snapshot still colors an ordinary previous day at its own midnight', () => {
  // 2026-09-06 has no local 00:00 in America/Santiago: the clock jumps 00:00 -> 01:00.
  const result = runChartChild('America/Santiago', '2026-09-06T15:00:00.000Z', [
    { id: 'ordinary', name: 'Early morning outage', status: 'resolved', impact: 'major', startedAt: '2026-09-05T04:15:00.000Z', endedAt: '2026-09-05T04:30:00.000Z', affectedComponents: ['API'] },
    { id: 'transition', name: 'Transition day outage', status: 'resolved', impact: 'minor', startedAt: '2026-09-06T04:05:00.000Z', endedAt: '2026-09-06T04:35:00.000Z', affectedComponents: ['API'] }
  ]);
  assert.equal(result.labels.length, 90);
  assert.equal(result.labels.at(-2), '05 Sept 2026');
  assert.equal(result.labels.at(-1), '06 Sept 2026');
  assert.equal(result.classes[result.labels.indexOf('05 Sept 2026')], 'incident-day major', 'an ordinary local day must still start at 00:00, not 01:00');
  assert.equal(result.classes[result.labels.indexOf('06 Sept 2026')], 'incident-day moderate', 'the skipped-midnight day starts at its true 01:00 local day start');
  assert.equal(result.classes[result.labels.indexOf('04 Sept 2026')], 'incident-day');
});

test('a Santiago window starting on the spring-forward day keeps every day at its own local start', () => {
  const result = runChartChild('America/Santiago', '2026-12-04T15:00:00.000Z', [
    { id: 'third', name: 'Third of December', status: 'resolved', impact: 'major', startedAt: '2026-12-03T03:15:00.000Z', endedAt: '2026-12-03T03:45:00.000Z', affectedComponents: ['API'] },
    { id: 'fourth', name: 'Fourth of December', status: 'resolved', impact: 'major', startedAt: '2026-12-04T03:15:00.000Z', endedAt: '2026-12-04T03:45:00.000Z', affectedComponents: ['API'] }
  ]);
  assert.equal(result.labels.length, 90);
  assert.equal(new Set(result.labels).size, 90);
  assert.equal(result.labels[0], '06 Sept 2026', 'the first window day is the skipped-midnight day');
  assert.equal(result.labels.at(-1), '04 Dec 2026');
  assert.equal(result.classes[0], 'incident-day', 'the skipped-midnight day itself stays uncolored');
  assert.equal(result.classes[result.labels.indexOf('03 Dec 2026')], 'incident-day major', 'the day before the snapshot is not polluted by the offset');
  assert.equal(result.classes[result.labels.indexOf('04 Dec 2026')], 'incident-day major', 'the snapshot day starts at its own local midnight');
  assert.equal(result.classes[result.labels.indexOf('02 Dec 2026')], 'incident-day');
});

// Mirrors the existing per-provider assertions in server.test.mjs so that
// extending that loop to all five providers stays green.
test('every provider page satisfies the shared attribution and typography checks', () => {
  for (const provider of PROVIDERS) {
    const html = page(provider), js = script(html);
    assert.doesNotThrow(() => new Function(js));
    assert.match(html, /<html lang="en">/);
    assert.match(html, new RegExp(`data-provider="${provider}"`));
    assert.match(html, /Official status data/);
    assert.match(html, /Self-hosted display; not operated by/);
    assert.doesNotMatch(js, /innerHTML|document\.write|localStorage|sessionStorage|Math\.random/);
    assert.match(js, /node\.textContent=text/);
    assert.match(js, /location\.protocol==='file:'/);
    assert.match(js, /\/api\/status\/\x27\+provider/);
    assert.doesNotMatch(html, /class="tabs"|data-provider="all"/);
    assert.match(html, /width=device-width, initial-scale=1/);
    assert.match(html, /font-size:clamp\(1rem,calc\(\.875rem \+ \.3vw\),1\.1875rem\)/);
    assert.match(html, /body\{font-size:1rem;line-height:1\.5\}/);
    assert.match(html, /\.name\{min-width:0;font-size:1rem(?:;|\})/);
    assert.match(html, /\.source\{font-size:\.8125rem/);
    assert.match(html, /@media\(max-width:560px\)/);
    assert.match(html, /@media\(max-width:360px\)/);
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale|\bzoom\s*:|transform\s*:\s*scale\(|parent\.document/);
  }
});
