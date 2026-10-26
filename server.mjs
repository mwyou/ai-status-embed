import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOpenAIHistory, parseClaudeHistory } from './history.mjs';
import { fetchGeminiSnapshot, GEMINI_STATUS_URL } from './gemini.mjs';
import { parseDeepSeekSummary, parseDeepSeekHistory, DEEPSEEK_OFFICIAL_URL } from './deepseek.mjs';
import { parseKimiSummary, parseKimiHistory, KIMI_STATUS_URL, KIMI_DATA_ROOT } from './kimi.mjs';

const PROVIDERS = Object.freeze({
  openai: { name: 'OpenAI', url: 'https://status.openai.com', api: 'https://status.openai.com/api/v2/summary.json' },
  claude: { name: 'Claude', url: 'https://status.claude.com', api: 'https://status.claude.com/api/v2/summary.json' },
  gemini: { name: 'Gemini', url: GEMINI_STATUS_URL },
  deepseek: { name: 'DeepSeek', url: DEEPSEEK_OFFICIAL_URL },
  kimi: { name: 'Kimi', url: KIMI_STATUS_URL, api: KIMI_DATA_ROOT + '/api/v2/summary.json' }
});
const PROVIDER_NAMES = Object.keys(PROVIDERS);
const LIMIT = 2 * 1024 * 1024;
export function framePolicy(value = '*') {
  const setting = value.trim();
  // Public, read-only pages allow any website by default; exact origins remain an optional restriction.
  if (setting === '*') return '*';
  const entries = setting.split(/\s+/);
  if (!entries.length || entries.some(entry => {
    if (entry === "'self'") return false;
    if (entry.includes('*')) return true;
    try {
      const u = new URL(entry);
      return !['https:', 'http:'].includes(u.protocol) || u.origin !== entry || !!u.username || !!u.password;
    } catch { return true; }
  })) throw new Error('EMBED_ORIGINS must be * or space-separated exact HTTP(S) origins or self');
  return entries.join(' ');
}
function normalize(data, provider, now) {
  if (!data || !Array.isArray(data.components) || !data.status || typeof data.status.indicator !== 'string') throw new Error('Unexpected upstream schema');
  const str = (v, max = 3000) => typeof v === 'string' ? v.slice(0, max) : '';
  return {
    provider, name: PROVIDERS[provider].name, officialUrl: PROVIDERS[provider].url,
    fetchedAt: new Date(now).toISOString(), sourceUpdatedAt: str(data.page?.updated_at),
    status: { indicator: str(data.status.indicator), description: str(data.status.description) },
    components: data.components.filter(c => c && c.group !== true).slice(0, 100).map(c => ({
      id: str(c.id), name: str(c.name), status: str(c.status), updatedAt: str(c.updated_at)
    })),
    groups: data.components.filter(c => c?.group === true).slice(0, 100).map(c => ({ id: str(c.id), name: str(c.name), status: str(c.status) })),
    incidentsAvailable: Array.isArray(data.incidents),
    incidents: (Array.isArray(data.incidents) ? data.incidents : []).filter(i => i && i.status !== 'resolved').slice(0, 30).map(i => ({
      id: str(i.id), name: str(i.name), status: str(i.status), impact: str(i.impact),
      createdAt: str(i.created_at), updatedAt: str(i.updated_at), body: str(i.incident_updates?.[0]?.body),
      affectedComponents: (Array.isArray(i.components) ? i.components : []).slice(0, 100).map(c => str(c?.name, 200)).filter(Boolean)
    }))
  };
}
async function boundedText(response) {
  if (!response.ok) throw new Error('Upstream request failed');
  if (Number(response.headers.get('content-length')) > LIMIT || !response.body) throw new Error('Invalid upstream size');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) throw new Error('Upstream too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createStatusServer({ fetchFn = globalThis.fetch, now = Date.now, cacheMs = 60000,
  retryMs = 15000, origins = process.env.EMBED_ORIGINS || '*', historyEnabled = true } = {}) {
  const policy = framePolicy(origins);
  const pages = Object.fromEntries(['index', ...PROVIDER_NAMES].map(provider => [provider, readFileSync(new URL(`./${provider}.html`, import.meta.url))]));
  const cache = new Map(), pending = new Map();
  // Request options come only from adapters with fixed official URLs, never from clients.
  async function upstream(url, format = 'json', request = {}) {
    const response = await fetchFn(url, {
      method: request.method || 'GET', ...(request.body ? { body: request.body } : {}),
      signal: AbortSignal.timeout(8000), redirect: 'error',
      headers: { accept: format === 'json' ? 'application/json' : 'text/html', 'user-agent': 'SelfHostedStatus/1.6', ...request.headers }
    });
    const text = await boundedText(response);
    return format === 'json' ? JSON.parse(text) : text;
  }
  async function history(provider, summary, markup) {
    if (!historyEnabled) return { available: false, stale: false, error: 'Historical data is unavailable.' };
    const components = summary.components;
    let result;
    if (provider === 'deepseek') result = parseDeepSeekHistory(markup, components);
    else if (provider === 'gemini') return summary.history;
    else if (provider === 'openai') result = parseOpenAIHistory(await upstream(PROVIDERS.openai.url, 'text'));
    else {
      const ids = components.map(c => c.id).filter(id => /^[a-z0-9]{8,32}$/.test(id));
      if (!ids.length) throw new Error('No valid official component IDs');
      const root = provider === 'kimi' ? KIMI_DATA_ROOT : 'https://status.claude.com';
      const url = root + '/uptime_showcase?components=' + encodeURIComponent(ids.slice(0, 60).join(','));
      const data = await upstream(url);
      result = provider === 'kimi' ? parseKimiHistory(data, components, summary.groups) : parseClaudeHistory(data, components);
    }
    return { ...result, fetchedAt: new Date(now()).toISOString(), stale: false, error: null };
  }
  async function load(provider) {
    const old = cache.get(provider);
    if (old && now() < old.nextAttempt) return old.result;
    if (pending.has(provider)) return pending.get(provider);
    const task = Promise.resolve().then(async () => {
      try {
        let summary, markup;
        if (provider === 'gemini') summary = await fetchGeminiSnapshot(upstream, now, historyEnabled);
        else if (provider === 'deepseek') {
          markup = await upstream(DEEPSEEK_OFFICIAL_URL, 'text');
          summary = parseDeepSeekSummary(markup, now());
        } else if (provider === 'kimi') summary = parseKimiSummary(await upstream(PROVIDERS.kimi.api), now());
        else summary = normalize(await upstream(PROVIDERS[provider].api), provider, now());
        let historical;
        try { historical = await history(provider, summary, markup); }
        catch {
          historical = old?.result.history?.available
            ? { ...old.result.history, stale: true, error: 'History refresh failed. Showing the last successfully fetched official history.' }
            : { available: false, stale: false, error: 'Official history is temporarily unavailable. No uptime values or history bars have been estimated.' };
        }
        const result = { ...summary, history: historical, stale: false, error: null };
        cache.set(provider, { result, nextAttempt: now() + cacheMs });
        return result;
      } catch {
        const result = old?.result.fetchedAt
          ? { ...old.result, stale: true, error: 'Refresh failed. Showing the last successfully fetched official data.' }
          : { provider, name: PROVIDERS[provider].name, officialUrl: PROVIDERS[provider].url,
              stale: true, fetchedAt: null, error: 'Unable to fetch official status data. Please try again later.' };
        cache.set(provider, { result, nextAttempt: now() + retryMs });
        return result;
      } finally { pending.delete(provider); }
    });
    pending.set(provider, task);
    return task;
  }
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors ${policy}; base-uri 'none'; form-action 'none'`);
    res.setHeader('Cache-Control', 'no-store');
    // Never log client URLs or forward embedding login tokens to official sources.
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
      if (path === '/' || path === '/index.html') {
        const provider = url.searchParams.get('provider');
        // Preserve explicitly selected legacy links, but never forward client tokens.
        if (PROVIDER_NAMES.includes(provider)) {
          const theme = url.searchParams.get('theme');
          res.writeHead(302, { Location: `/${provider}.html` + (['dark', 'light'].includes(theme) ? `?theme=${theme}` : '') });
          return res.end();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(req.method === 'HEAD' ? undefined : pages.index);
      }
      const page = /^\/(openai|claude|gemini|deepseek|kimi)(?:\.html)?$/.exec(path);
      if (page) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(req.method === 'HEAD' ? undefined : pages[page[1]]); }
      if (path === '/healthz') { res.setHeader('Content-Type', 'application/json'); return res.end(req.method === 'HEAD' ? undefined : '{"ok":true}'); }
      const match = /^\/api\/status\/(openai|claude|gemini|deepseek|kimi)$/.exec(path);
      if (match) {
        const result = await load(match[1]);
        res.statusCode = result.fetchedAt ? 200 : 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result));
      }
      res.writeHead(404); res.end('Not found');
    } catch { res.writeHead(500); res.end('Internal error'); }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8099), host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createStatusServer();
  server.listen(port, host, () => console.log(`Status service listening on ${host}:${port}`));
  const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
