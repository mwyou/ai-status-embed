import { load } from 'cheerio';
export const KIMI_STATUS_URL = 'https://status.moonshot.cn';
export const KIMI_DATA_ROOT = 'https://10y9y5wx5xh3.statuspage.io';
const clean = (value, max = 3000) => typeof value === 'string' ? value.slice(0, max) : '';
const nonEnglish = value => /[\u3400-\u9fff]/.test(value || '');
function english(value, fallback) { return nonEnglish(value) ? fallback : clean(value) || fallback; }
function percent(value) { const s = String(value ?? '').trim(); return /^\d{1,3}(?:\.\d+)?$/.test(s) && Number(s) <= 100 ? s : null; }
export function parseKimiSummary(data, nowMs) {
  if (!data || data.page?.id !== '10y9y5wx5xh3' || data.page?.url?.replace(/\/$/, '') !== KIMI_STATUS_URL || !Array.isArray(data.components) || typeof data.status?.indicator !== 'string') throw new Error('Official Kimi summary schema changed');
  const groups = data.components.filter(c => c?.group === true).slice(0, 100).map(c => ({ id: clean(c.id, 100), name: english(c.name, 'Official group ' + clean(c.id, 100)), status: clean(c.status) }));
  const components = data.components.filter(c => c && c.group !== true).slice(0, 100).map(c => ({ id: clean(c.id, 100), name: english(c.name, 'Official component ' + clean(c.id, 100)), status: clean(c.status), updatedAt: clean(c.updated_at), groupId: clean(c.group_id, 100) }));
  return { provider: 'kimi', name: 'Kimi', officialUrl: KIMI_STATUS_URL, fetchedAt: new Date(nowMs).toISOString(), sourceUpdatedAt: clean(data.page.updated_at),
    status: { indicator: clean(data.status.indicator), description: english(data.status.description, 'See the official status page for the current report.') }, groups, components,
    incidentsAvailable: Array.isArray(data.incidents), incidents: (Array.isArray(data.incidents) ? data.incidents : []).filter(i => i && i.status !== 'resolved').slice(0, 30).map(i => ({
      id: clean(i.id, 100), name: english(i.name, 'Official incident ' + clean(i.id, 100)), status: clean(i.status), impact: clean(i.impact), createdAt: clean(i.created_at), updatedAt: clean(i.updated_at),
      body: nonEnglish(i.incident_updates?.[0]?.body) ? 'The official update is not published in English. Read the original on the official status page.' : clean(i.incident_updates?.[0]?.body),
      affectedComponents: (Array.isArray(i.components) ? i.components : []).slice(0, 100).map(c => english(c?.name, 'Official component ' + clean(c?.id, 100))),
      originalLanguageNote: nonEnglish(i.name) || nonEnglish(i.incident_updates?.[0]?.body) ? 'Original update is not published in English; it has not been translated.' : null
    })) };
}
export function parseKimiHistory(data, components, groups = []) {
  if (!data || typeof data.components !== 'object' || !Array.isArray(data.values)) throw new Error('Official Kimi history schema changed');
  const metrics = new Map(data.values.map(v => [v.component, v.ninety]));
  const rows = components.map(component => {
    const markup = data.components[component.id];
    if (typeof markup !== 'string') return { ...component, uptime: null, days: [], components: [] };
    const $ = load(markup), rects = $('rect.uptime-day'), timeline = data.timelines?.[component.id]?.days;
    if (rects.length > 120) throw new Error('Unexpected official history length');
    const days = rects.map((i, rect) => {
      const node = $(rect), indexText = /(?:^|\s)day-(\d+)(?:\s|$)/.exec(node.attr('class') || '')?.[1];
      const index = indexText === undefined ? null : Number(indexText);
      const day = index !== null && Array.isArray(timeline) ? timeline[index] : null;
      const fill = (node.attr('fill') || '').toLowerCase(), color = /^#[0-9a-f]{6}$/.test(fill) ? fill : null;
      // Statuspage publishes interpolated colors, not only a discrete status palette.
      // Preserve those SVG colors; never infer the day from incidents or outage duration.
      return { state: fill === '#1e8542' ? 'operational' : fill === '#b3bac5' || !color ? 'unknown' : 'official_history', color,
        date: typeof day?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? day.date : null,
        events: Array.isArray(day?.related_events) ? day.related_events.slice(0, 10).map(event => english(event?.name, 'Official incident ' + clean(event?.code, 100) + ' (original text is not published in English)')) : [] };
    }).get();
    return { ...component, uptime: rects.length ? percent(metrics.get(component.id)) : null, days, components: [] };
  });
  if (!rows.some(row => row.days.length)) throw new Error('Official Kimi history missing');
  const used = new Set();
  const grouped = groups.map(group => {
    const children = rows.filter(row => row.groupId === group.id); children.forEach(row => used.add(row.id));
    return { ...group, uptime: null, days: [], components: children, componentCount: children.length };
  }).filter(group => group.components.length);
  grouped.push(...rows.filter(row => !used.has(row.id)));
  return { available: true, sourceUrl: KIMI_STATUS_URL, snapshotKind: 'official-statuspage', rangeLabel: 'Past 90 days (available history only)', rows: grouped,
    metricsNote: 'Coverage follows the official Moonshot AI status page; regional coverage is not specified. Mixed-color bars preserve the official chart colors. Grey bars mean unavailable history, including dates before a component was added; published uptime applies to available history. Updates not published in English are linked on the official site rather than translated.' };
}
