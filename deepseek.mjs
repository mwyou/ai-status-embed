import { load } from 'cheerio';

/**
 * DeepSeek official status adapter.
 *
 * The official status page (https://status.deepseek.com, linked from the official
 * "Resources / API Status" section of https://api-docs.deepseek.com) is served by
 * Flashduty as a Next.js SSR page. The V2 JSON summary endpoint is not available,
 * so this adapter reads the official server-rendered markup only:
 *
 *   - `div#S:5`  hidden div: overall status card (colored dot, headline, detail)
 *   - `div#S:6`  hidden div: "System status" card with per-component rows, charts
 *                and official uptime percentages
 *   - `self.__next_f.push([1,"..."])` flight lines: JSON payload with the official
 *     change summary (`active_changes`) and uptime/impact series
 *
 * Only JSON is parsed; no upstream code is ever evaluated (no eval, no vm).
 */

export const DEEPSEEK_OFFICIAL_URL = 'https://status.deepseek.com';
export const DEEPSEEK_SOURCE_URL = 'https://status.deepseek.com';
const PROVIDER = 'deepseek';
const NAME = 'DeepSeek';

/**
 * Official DeepSeek severity tokens (as rendered by the official page component)
 * mapped onto the Statuspage vocabulary used by the rest of this service, so the
 * existing pages/server can consume the adapter without new vocabularies.
 */
const STATUS_PAGE_INDICATOR = Object.freeze({
  operational: 'none', degraded: 'minor', partial_outage: 'major',
  full_outage: 'critical', maintenance: 'maintenance'
});
const COMPONENT_STATUS = Object.freeze({
  operational: 'operational', degraded: 'degraded_performance',
  partial_outage: 'partial_outage', full_outage: 'major_outage',
  maintenance: 'under_maintenance'
});
const IMPACT = Object.freeze({
  operational: 'none', degraded: 'minor', partial_outage: 'major',
  full_outage: 'critical', maintenance: 'maintenance'
});
const SEVERITY_RANK = Object.freeze({ operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, full_outage: 4 });

/** Official status dot classes (`bg-<tone>-500`) -> official severity token. */
const DOT_SEVERITY = Object.freeze({
  'bg-green-500': 'operational', 'bg-yellow-500': 'degraded', 'bg-orange-500': 'partial_outage',
  'bg-red-500': 'full_outage', 'bg-blue-500': 'maintenance'
});
/**
 * Official history bar fills, verified against the live https://status.deepseek.com SVG bars
 * (the only four fills the official chart paints: #22c55e green, #eab308 yellow, #f97316
 * orange, #ef4444 red; #3b82f6 is the official blue used for scheduled maintenance).
 * The colour is preserved verbatim on every bar so the view can match the official palette.
 */
const BAR_STATE = Object.freeze({
  '#22c55e': 'operational', '#eab308': 'degraded_performance', '#f97316': 'partial_outage',
  '#ef4444': 'major_outage', '#3b82f6': 'under_maintenance'
});
/** Official chart colours are always six-digit hex; anything else is never used as a style. */
const HEX_COLOR = /^#[0-9a-f]{6}$/;
/** Official affected-component status tokens (official `q()` normalizer). */
const AFFECTED_SEVERITY = Object.freeze({
  operational: 'operational', degraded: 'degraded', partial_outage: 'partial_outage',
  full_outage: 'full_outage', maintenance: 'maintenance', under_maintenance: 'maintenance'
});

/**
 * Official English UI vocabulary (verified in the official i18n dictionary shipped
 * with the page). Used verbatim as a fallback so no sentence is ever translated or
 * invented by the adapter.
 */
const DEFAULT_STATUS_LABELS = Object.freeze({
  operational: 'All Systems Operational', degraded: 'Degraded Performance',
  partial_outage: 'Partial Outage', full_outage: 'Full Outage', maintenance: 'Under Maintenance'
});
const DEFAULT_STATUS_DESCRIPTIONS = Object.freeze({
  operational: 'All services are running normally',
  degraded: 'Some services are experiencing degraded performance',
  partial_outage: 'Some services are experiencing issues',
  full_outage: 'Critical services are down',
  maintenance: 'Scheduled maintenance in progress'
});
const DEFAULT_INCIDENT_LABELS = Object.freeze({ title: 'Incident', maintenance: 'Maintenance' });

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const MAX_BARS = 400;

/** Collapse whitespace, drop control characters and neutralise any markup characters. */
function text(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Official uptime strings are rendered as "{percentage}% uptime"; keep the exact digits. */
function percentText(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{1,3}(?:\.\d+)?)\s*%\s*uptime$/.exec(raw);
  if (!match) return null;
  return Number(match[1]) <= 100 ? match[1] : null;
}

function secondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  try { return new Date(seconds * 1000).toISOString(); } catch { return ''; }
}

function latinTokens(value) {
  return text(value.replace(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/g, ' '), 500)
    .split(' ')
    .map(token => token.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, ''))
    .filter(Boolean);
}

/**
 * Extract the official English portion of a bilingual official field.
 *
 * Handles the two official formats:
 *   1. two-line bilingual text: "<Chinese line>\n\n<English line>"
 *   2. inline bilingual text:   "<Chinese prefix>(<English>)"
 *
 * Brand/model tokens that only exist in the Chinese prefix are preserved, so
 * "DeepSeek V4 Pro API服务(API Service)" -> "DeepSeek V4 Pro API Service" instead of
 * collapsing both API rows to "(API Service)".
 *
 * Returns null when the field carries no official English text (so callers can use an
 * official English label instead of fabricating a translation).
 */
export function parseEnglishText(value) {
  const source = typeof value === 'string' ? value.replace(/\r/g, '') : '';
  if (!source.trim()) return null;

  const paragraphs = source.split(/\n+/).map(part => part.trim()).filter(Boolean);
  const ascii = paragraphs.filter(part => !CJK.test(part) && /[A-Za-z]/.test(part));
  if (ascii.length && ascii.length < paragraphs.length) {
    return text(ascii.join(' '), 3000) || null;
  }

  const flat = source.replace(/\s+/g, ' ').trim();
  const bracket = /^(.*?)[（(]([^（()）]*)[)）]\s*$/.exec(flat);
  if (bracket) {
    const inner = text(bracket[2], 3000);
    if (!inner) return null;
    // Reversed bilingual order: the parenthetical is Chinese, so only the English prefix survives.
    if (CJK.test(inner)) return text(latinTokens(bracket[1]).join(' '), 3000) || null;
    const prefix = latinTokens(bracket[1]);
    const lowered = inner.toLowerCase();
    const missing = prefix.filter(token => token.length > 1 && !lowered.includes(token.toLowerCase()));
    return text([...missing, inner].join(' '), 3000) || inner;
  }

  if (!CJK.test(source)) return text(source, 3000) || null;
  return null;
}

/** JSON-only flight payload; each `self.__next_f.push([1,"…"])` literal is decoded with JSON.parse. */
const FLIGHT_PUSH = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;

function flightPayload(html) {
  if (typeof html !== 'string') return '';
  const parts = [];
  for (const match of html.matchAll(FLIGHT_PUSH)) {
    try {
      const value = JSON.parse(match[1]);
      if (typeof value === 'string') parts.push(value);
    } catch { /* not a JSON string literal: ignore */ }
  }
  return parts.join('');
}

/** Balanced-brace extraction of one JSON object, string/escape aware. */
function objectAt(textValue, start) {
  if (textValue[start] !== '{') return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < textValue.length; i++) {
    const char = textValue[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { depth--; if (depth === 0) return textValue.slice(start, i + 1); }
  }
  return null;
}

/** Every official `"initialData":{…}` payload found in the flight stream, JSON.parsed. */
function flightObjects(payload) {
  const objects = [];
  const anchor = '"initialData":';
  let index = -1;
  while ((index = payload.indexOf(anchor, index + 1)) >= 0) {
    const open = payload.indexOf('{', index + anchor.length);
    if (open < 0) continue;
    const raw = objectAt(payload, open);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed);
    } catch { /* not parseable: treated as missing below */ }
  }
  return objects;
}

function sourceUpdatedAt(payload) {
  const match = /"initialDataUpdatedAt"\s*:\s*(\d{10,16})/.exec(payload);
  if (!match) return '';
  const ms = Number(match[1]);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try { return new Date(ms).toISOString(); } catch { return ''; }
}

/** Official English i18n labels, merged over verified defaults (dictionary is optional). */
function officialLabels(payload) {
  const labels = {
    status: { ...DEFAULT_STATUS_LABELS }, statusDescription: { ...DEFAULT_STATUS_DESCRIPTIONS },
    incident: { ...DEFAULT_INCIDENT_LABELS }
  };
  const anchor = payload.indexOf('"messages":');
  if (anchor < 0) return labels;
  const open = payload.indexOf('{', anchor + '"messages":'.length);
  const raw = open < 0 ? null : objectAt(payload, open);
  if (!raw) return labels;
  let messages;
  try { messages = JSON.parse(raw); } catch { return labels; }
  for (const key of Object.keys(DEFAULT_STATUS_LABELS)) {
    if (typeof messages?.status?.[key] === 'string') labels.status[key] = text(messages.status[key], 200);
    const description = messages?.status?.[`${key}Desc`];
    if (typeof description === 'string') labels.statusDescription[key] = text(description, 300);
  }
  if (typeof messages?.incident?.title === 'string') labels.incident.title = text(messages.incident.title, 100);
  if (typeof messages?.incident?.maintenance === 'string') labels.incident.maintenance = text(messages.incident.maintenance, 100);
  return labels;
}

/** Official severity token from an official status dot class, or null when the palette changed. */
function dotSeverity(classAttribute) {
  const list = typeof classAttribute === 'string' ? classAttribute.split(/\s+/) : [];
  for (const className of list) if (DOT_SEVERITY[className]) return DOT_SEVERITY[className];
  return null;
}

/** The "System status" section, anchored by the official hidden div id or its official heading. */
function systemSection($) {
  const byId = $('[id="S:6"]').first();
  if (byId.length && byId.find('div.divide-y').length) return byId;
  const card = $('h2').filter((i, element) => text($(element).text(), 80) === 'System status').first().closest('div.rounded-xl');
  return card.length ? card : $();
}

/** The overall status card, anchored by the official hidden div id or its structure. */
function overallCard($) {
  const byId = $('[id="S:5"]').first();
  if (byId.length && byId.find('h2').length) return byId;
  const systems = systemSection($);
  return $('div.rounded-xl').filter((i, element) => {
    const node = $(element);
    if (systems.length && node[0] === systems[0]) return false;
    // The "System status" card has no paragraph; the overall card has headline + detail.
    return node.find('h2').length === 1 && node.find('p').length >= 1;
  }).first();
}

function readUptime($, scope) {
  const fast = scope.find('div.whitespace-nowrap');
  if (fast.length) {
    const parsed = percentText(fast.first().text());
    if (parsed !== null) return parsed;
  }
  let found = null;
  scope.find('span,div,p').each((i, element) => {
    if (found !== null) return;
    const node = $(element);
    if (node.children().length) return;
    const parsed = percentText(node.text());
    if (parsed !== null) found = parsed;
  });
  return found;
}

/**
 * Official SVG bars, in DOM order, mapped to official states.
 *
 * The official fill is preserved verbatim on every bar as `day.color` so the view can render
 * the exact official palette. A recognized official fill carries its official severity; any
 * other verified official hex colour keeps its colour but is reported as `official_history`
 * (never a fabricated severity and never healthy). A missing/unparseable fill is `unknown`.
 * No bar, date or severity is ever estimated from uptime or incident duration.
 */
function readDays($, chart) {
  const rects = $(chart).find('rect');
  if (rects.length > MAX_BARS) throw new Error('Unexpected DeepSeek history length');
  return rects.map((i, rect) => {
    const fill = String($(rect).attr('fill') || '').trim().toLowerCase();
    const color = HEX_COLOR.test(fill) ? fill : null;
    const state = BAR_STATE[fill] || (color ? 'official_history' : 'unknown');
    return { state, color, date: null, events: [] };
  }).get();
}

function readRow($, scope) {
  const rawName = text(scope.find('span.font-medium').first().text(), 300);
  const severity = dotSeverity(scope.find('div.rounded-full.shrink-0').first().attr('class'));
  const chart = scope.find('svg[class*="mt-3"]').first();
  return {
    rawName,
    // Official page is English-only: prefer the official English portion of the bilingual name.
    name: parseEnglishText(rawName) || rawName,
    severity,
    uptime: readUptime($, scope),
    days: chart.length ? readDays($, chart) : []
  };
}

/**
 * Read the official component rows from `div#S:6`.
 *
 * A section row owns the chart inside its own button; the collapsed children container is a
 * sibling, so child charts can never be merged into the parent series.
 */
function readComponentGroups($) {
  const systems = systemSection($);
  if (!systems.length) throw new Error('Official DeepSeek page layout changed');
  const container = systems.find('div.divide-y').first();
  const nodes = container.children('div');
  if (!container.length || !nodes.length || nodes.length > 100) throw new Error('Official DeepSeek component list changed');
  const groups = nodes.map((index, element) => {
    const node = $(element);
    const isSection = node.children('button').length > 0;
    const primary = readRow($, isSection ? node.children('button').first() : node);
    const children = [];
    if (isSection) {
      const inner = node.children('div.overflow-hidden').first().children('div').first();
      inner.children().each((i, child) => children.push(readRow($, $(child))));
    }
    return { isSection, primary, children };
  }).get();
  const flat = groups.flatMap(group => [group.primary, ...group.children]);
  if (!flat.length || flat.some(row => !row.rawName)) throw new Error('Official DeepSeek component list changed');
  return groups;
}

/** Official component_id / section_id lookups declared in the flight payload. */
function officialIdMaps(objects) {
  const component = new Map(), section = new Map();
  const page = objects.find(object => object.page && Array.isArray(object.page.components))?.page;
  if (page) {
    for (const entry of page.components) {
      if (entry && typeof entry.name === 'string' && entry.component_id) component.set(text(entry.name, 300), String(entry.component_id));
    }
    for (const entry of Array.isArray(page.sections) ? page.sections : []) {
      if (entry && typeof entry.name === 'string' && entry.section_id) section.set(text(entry.name, 300), String(entry.section_id));
    }
  }
  return { component, section };
}

/** Merge the official id maps with the caller-supplied component list (English names included). */
function idLookup(official, components) {
  const component = new Map(official.component), section = new Map(official.section);
  for (const entry of Array.isArray(components) ? components : []) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
    const id = String(entry.id ?? '');
    if (!id) continue;
    component.set(entry.name, id);
    const english = parseEnglishText(entry.name);
    if (english) component.set(english, id);
  }
  return { component, section };
}

function rowId(row, ids) {
  return ids.get(row.name) || ids.get(row.rawName) || '';
}

function toComponent(row, ids) {
  const id = ids.component.get(row.rawName) || ids.component.get(row.name) || '';
  return { id, name: row.name, status: row.severity ? COMPONENT_STATUS[row.severity] : 'unknown', updatedAt: '' };
}

/** Official severity of one affected-component entry, or null when unknown. */
function changeImpact(change) {
  if (change.type === 'maintenance') return IMPACT.maintenance;
  let worst = 'operational';
  for (const affected of Array.isArray(change.affected_components) ? change.affected_components : []) {
    const severity = AFFECTED_SEVERITY[affected?.status] ?? null;
    // The official merge counts only degraded/partial/full outages for incident impact.
    if (!severity || severity === 'maintenance' || severity === 'operational') continue;
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
  }
  return IMPACT[worst];
}

function incidentFromChange(change, labels) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw new Error('Official DeepSeek active change schema changed');
  }
  const id = String(change.change_id ?? '');
  const status = typeof change.status === 'string' ? change.status : '';
  if (!id || typeof change.title !== 'string' || !status) {
    throw new Error('Official DeepSeek active change schema changed');
  }
  const updates = Array.isArray(change.updates) ? change.updates.filter(entry => entry && typeof entry === 'object') : [];
  const latest = updates.reduce((best, entry) => (Number(entry.at_seconds) >= Number(best?.at_seconds ?? -Infinity) ? entry : best), null);
  const body = parseEnglishText(latest?.description) || parseEnglishText(change.description) || '';
  const name = parseEnglishText(change.title) || (change.type === 'maintenance' ? labels.incident.maintenance : labels.incident.title);
  return {
    id, name, status, impact: changeImpact(change),
    createdAt: secondsToIso(change.start_at_seconds),
    updatedAt: secondsToIso(latest?.at_seconds ?? change.close_at_seconds ?? change.start_at_seconds),
    body: body.slice(0, 3000),
    affectedComponents: (Array.isArray(change.affected_components) ? change.affected_components : [])
      .slice(0, 100)
      .map(entry => parseEnglishText(entry?.name) || '')
      .filter(Boolean)
  };
}

/**
 * Official overall status from the `div#S:5` card.
 *
 * An unrecognized dot colour means the official status vocabulary changed: throw rather than
 * report a healthy headline.
 */
function overallStatus($) {
  const card = overallCard($);
  if (!card.length) throw new Error('Official DeepSeek page layout changed');
  const title = text(card.find('h2').first().text(), 300);
  const description = text(card.find('p').first().text(), 300);
  const dotClass = card.find('h2 div.rounded-full').first().attr('class') || card.find('div.rounded-full').first().attr('class') || '';
  const severity = dotSeverity(dotClass);
  if (!severity) throw new Error('Unexpected official DeepSeek overall status');
  return { severity, title, description };
}

/**
 * Official DeepSeek summary in the same shape as the server's `normalize` output.
 *
 * `active_changes` is authoritative only when the official payload carries the array; a
 * missing/!array field throws instead of implying "no incidents".
 * Resolved/completed changes are historical and are never surfaced as active incidents.
 */
export function parseDeepSeekSummary(html, nowMs) {
  if (typeof html !== 'string' || !html) throw new Error('Official DeepSeek page markup missing');
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const $ = load(html);
  const groups = readComponentGroups($);
  const overall = overallStatus($);
  const payload = flightPayload(html);
  const objects = flightObjects(payload);
  const changeSummary = objects.find(object => Array.isArray(object.active_changes));
  if (!changeSummary) throw new Error('Official DeepSeek active change summary missing');
  const labels = officialLabels(payload);
  const ids = idLookup(officialIdMaps(objects), []);
  const components = groups
    .flatMap(group => (group.isSection && group.children.length ? group.children : [group.primary]))
    .map(row => toComponent(row, ids));
  if (!components.length || components.some(component => !component.name)) throw new Error('Official DeepSeek component list changed');
  const incidents = changeSummary.active_changes
    .filter(change => !['resolved', 'completed'].includes(String(change?.status)))
    .slice(0, 30)
    .map(change => incidentFromChange(change, labels));
  return {
    provider: PROVIDER, name: NAME, officialUrl: DEEPSEEK_OFFICIAL_URL,
    fetchedAt: new Date(at).toISOString(),
    sourceUpdatedAt: sourceUpdatedAt(payload),
    status: {
      indicator: STATUS_PAGE_INDICATOR[overall.severity],
      description: overall.title || overall.description || labels.statusDescription[overall.severity] || labels.status[overall.severity] || ''
    },
    components,
    // Present => the official payload explicitly told us which changes are active.
    incidentsAvailable: true,
    incidents
  };
}

/** Official reporting-period label rendered next to the "System status" heading. */
function rangeLabel($, systems) {
  let label = '';
  systems.find('span').each((i, element) => {
    if (label) return;
    const value = text($(element).text(), 100);
    if (/^[A-Z][a-z]{2} \d{4}\s*-\s*[A-Z][a-z]{2} \d{4}$/.test(value)) label = value;
  });
  return label;
}

/**
 * Official DeepSeek history from the same markup.
 *
 * Bars are mapped in DOM order from the official SVG `fill` attributes; percentages are the
 * official DOM text verbatim; dates are unknown in this snapshot (null) and no bar, date or
 * uptime value is reconstructed. Layout drift throws, which never invalidates the summary.
 */
export function parseDeepSeekHistory(html, components = []) {
  if (typeof html !== 'string' || !html) throw new Error('Official DeepSeek page markup missing');
  const $ = load(html);
  const groups = readComponentGroups($);
  const systems = systemSection($);
  const label = rangeLabel($, systems);
  if (!label) throw new Error('Official DeepSeek history layout changed');
  const ids = idLookup(officialIdMaps(flightObjects(flightPayload(html))), components);
  const toRow = (row, id) => ({
    ...(id ? { id } : {}),
    name: row.name,
    status: row.severity ? COMPONENT_STATUS[row.severity] : 'unknown',
    uptime: row.uptime,
    days: row.days,
    components: []
  });
  const rows = groups.map(group => {
    const primary = toRow(group.primary, rowId(group.primary, group.isSection ? ids.section : ids.component));
    if (group.isSection) {
      primary.components = group.children.map(child => toRow(child, rowId(child, ids.component)));
      primary.componentCount = primary.components.length;
    }
    return primary;
  });
  if (!rows.length || rows.some(row => !row.name) || !rows.some(row => row.days.length >= 20)) {
    throw new Error('Official DeepSeek history missing');
  }
  return {
    available: true, sourceUrl: DEEPSEEK_SOURCE_URL, snapshotKind: 'official-html',
    rangeLabel: label, rows
  };
}
