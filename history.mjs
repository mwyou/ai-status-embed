import { load } from 'cheerio';

const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
function percent(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,3}(?:\.\d+)?$/.test(text) && Number(text) <= 100 ? text : null;
}
function iconState(classes = '') {
  if (/text-icon-operational(?:\s|$)/.test(classes)) return 'operational';
  if (/text-icon-(?:degraded[-_]performance|degraded)(?:\s|$)/.test(classes)) return 'degraded_performance';
  if (/text-icon-partial[-_]outage(?:\s|$)/.test(classes)) return 'partial_outage';
  if (/text-icon-(?:full[-_]outage|major[-_]outage)(?:\s|$)/.test(classes)) return 'major_outage';
  if (/text-icon-(?:under[-_]maintenance|maintenance)(?:\s|$)/.test(classes)) return 'under_maintenance';
  return 'unknown';
}
function pillState(classes = '') {
  if (/pillOperational(?:\s|$)/.test(classes)) return 'operational';
  if (/pillDegradedPerformance(?:\s|$)/.test(classes)) return 'degraded_performance';
  if (/pillPartialOutage(?:\s|$)/.test(classes)) return 'partial_outage';
  if (/pill(?:FullOutage|MajorOutage)(?:\s|$)/.test(classes)) return 'major_outage';
  if (/pill(?:Maintenance|UnderMaintenance)(?:\s|$)/.test(classes)) return 'under_maintenance';
  return 'unknown';
}

export function parseOpenAIHistory(html) {
  const $ = load(html);
  const system = $('[data-testid="system-status"]');
  const groups = system.find('div.divide-y').first().children('div');
  if (!system.length || !groups.length || groups.length > 50) throw new Error('Official OpenAI layout changed');
  function row(header, wrapper) {
    const charts = wrapper.find('svg').filter((i, svg) => {
      if ($(svg).find('rect').length < 20) return false;
      // A collapsed descendant contains child charts, not the group's own chart.
      for (let parent = svg.parent; parent && parent !== wrapper[0]; parent = parent.parent) {
        if (parent.attribs?.['data-state'] === 'closed') return false;
      }
      return true;
    });
    const rects = charts.last().find('rect');
    if (rects.length > 120) throw new Error('Unexpected history length');
    return {
      name: clean(header.find('h3').first().text()),
      status: iconState(header.find('svg').first().attr('class')),
      uptime: percent(header.find('var[percentage]').first().text()),
      days: rects.map((i, rect) => ({ state: pillState($(rect).attr('class')), date: null, events: [] })).get()
    };
  }
  const rows = groups.map((i, group) => {
    const node = $(group), headers = node.find('div.h-7');
    if (!headers.length || headers.length > 101) throw new Error('Unexpected group structure');
    const primary = row(headers.first(), node);
    primary.components = headers.slice(1).map((i, header) => row($(header), $(header).parent())).get();
    primary.componentCount = primary.components.length;
    return primary;
  }).get();
  if (rows.some(r => !r.name) || !rows.some(r => r.days.length >= 20)) throw new Error('Official history missing');
  const banner = $('[data-testid="heads-up"]');
  const incidentCards = banner.find('a[href^="/incidents/"]');
  const incidents = incidentCards.slice(0, 30).map((i, link) => {
    const card = $(link), id = /^\/incidents\/([A-Za-z0-9_-]{8,80})$/.exec(card.attr('href') || '')?.[1];
    if (!id) return null;
    const affected = clean(card.find('span').filter((i, span) => /^Affects\s/.test(clean($(span).text()))).first().text());
    const duration = clean(card.find('var[duration]').first().parent().text());
    const status = clean(card.find('span').filter((i, span) => ['Investigating', 'Identified', 'Monitoring'].includes(clean($(span).text()))).first().text()).toLowerCase();
    return {
      id, name: clean(card.find('div.font-medium').first().text()),
      body: card.find('p').map((i, p) => clean($(p).text())).get().filter(Boolean).join('\n\n').slice(0, 3000),
      status, impact: iconState(card.find('svg').first().attr('class')),
      affectedComponents: affected ? affected.replace(/^Affects\s+/, '').split(/,\s*/).filter(Boolean).slice(0, 100) : [],
      durationText: /^Ongoing for \d+ (?:minutes?|hours?|days?)$/.test(duration) ? duration : null
    };
  }).get().filter(Boolean);
  const hasBadges = banner.find('[class*="ComponentBadge"] span').length > 0;
  return {
    available: true, sourceUrl: 'https://status.openai.com', snapshotKind: 'official-html',
    rangeLabel: clean(system.find('.select-none').first().text()).replace(/\s*-\s*/, ' - ') || 'Official reporting period',
    rows, incidents,
    overall: {
      title: clean(banner.find('li').first().text()),
      // In a degraded banner .p-4 contains service badges, not the incident description.
      description: incidentCards.length || hasBadges ? '' : clean(banner.find('div.p-4').first().text()),
      status: iconState(banner.find('li svg').first().attr('class'))
    }
  };
}

// Pure published status colors have a known meaning. Statuspage also publishes
// interpolated daily fills: keep those colors without inventing a severity.
const CLAUDE_COLORS = Object.freeze({
  '#76ad2a': 'operational', '#faa72a': 'degraded_performance', '#e86235': 'partial_outage',
  '#e04343': 'major_outage', '#2c84db': 'under_maintenance', '#b3bac5': 'unknown'
});
export function parseClaudeHistory(data, components) {
  if (!data || !data.components || !Array.isArray(data.values)) throw new Error('Official Claude history schema changed');
  const metrics = new Map(data.values.map(value => [value.component, value.ninety]));
  const rows = components.map(component => {
    const markup = data.components[component.id];
    if (typeof markup !== 'string') return { ...component, uptime: null, days: [], components: [] };
    const $ = load(markup);
    const timeline = data.timelines?.[component.id]?.days;
    const rects = $('rect.uptime-day');
    if (rects.length > 120) throw new Error('Unexpected history length');
    const days = rects.map((i, rect) => {
      const node = $(rect), index = Number(/(?:^|\s)day-(\d+)(?:\s|$)/.exec(node.attr('class') || '')?.[1]);
      const day = Number.isInteger(index) && Array.isArray(timeline) ? timeline[index] : null;
      const fill = (node.attr('fill') || '').trim().toLowerCase();
      const color = /^#[0-9a-f]{6}$/.test(fill) ? fill : null;
      return {
        state: CLAUDE_COLORS[fill] || (color ? 'official_history' : 'unknown'), color,
        date: typeof day?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? day.date : null,
        events: Array.isArray(day?.related_events) ? day.related_events.slice(0, 10).map(event => clean(event.name)).filter(Boolean) : []
      };
    }).get();
    return { ...component, uptime: percent(metrics.get(component.id)), days, components: [] };
  });
  if (!rows.some(row => row.days.length >= 20)) throw new Error('Official history missing');
  return { available: true, sourceUrl: 'https://status.claude.com/uptime', rangeLabel: 'Past 90 days', rows };
}
