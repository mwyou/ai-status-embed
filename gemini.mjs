// Google AI Studio's public status page and its read-only incident-history RPC.
// The page's frontend keys are transient public client configuration, never logged,
// persisted, hardcoded, or sent to clients. No customer API key is needed.
export const GEMINI_STATUS_URL = 'https://aistudio.google.com/status';
export const GEMINI_INCIDENTS_RPC = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListIncidentsHistory';
const PRODUCTS = Object.freeze({ 1: 'API', 2: 'Multimodal Live API', 3: 'Google AI Studio' });
const UPDATE_STATES = Object.freeze({ 1: 'investigating', 2: 'identified', 3: 'monitoring', 4: 'resolved', 5: 'mitigated' });
const text = (value, max = 3000) => typeof value === 'string' ? value.slice(0, max) : '';
function timestamp(update) {
  const tuple = update?.[2];
  const seconds = Number(tuple?.[0]), nanos = Number(tuple?.[1] ?? 0);
  if (!Array.isArray(tuple) || tuple.length < 1 || tuple.length > 2 || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8640000000000 || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) throw new Error('Invalid official incident timestamp');
  return new Date(seconds * 1000 + nanos / 1e6).toISOString();
}
export function parseGeminiSnapshot(data, nowMs, historyEnabled = true) {
  if (!Array.isArray(data) || !Array.isArray(data[0]) || !Array.isArray(data[0][0]) || data[0][0].length > 1000) throw new Error('Official Gemini incident schema changed');
  const fetchedAt = new Date(nowMs).toISOString();
  const records = data[0][0].map(item => {
    if (!Array.isArray(item) || !text(item[0]) || !text(item[1]) || ![1, 2].includes(item[2]) || !Array.isArray(item[3]) || !item[3].length || !Array.isArray(item[5]) || !item[5].length) throw new Error('Invalid official Gemini incident');
    if (item[5].some(id => !Number.isInteger(id) || id <= 0)) throw new Error('Invalid official product');
    const updates = item[3].map(update => {
      if (!Array.isArray(update) || !Object.hasOwn(UPDATE_STATES, update[0])) throw new Error('Unknown official incident state');
      return { status: UPDATE_STATES[update[0]], at: timestamp(update), body: text(update[3]), chartOrder: update[2].toString(), seconds: Number(update[2][0]), nanos: Number(update[2][1] ?? 0) };
    });
    // Official /status lazy module Zg7ntb, eTg: compare Timestamp objects by
    // their protobuf-array string representation, not by array position. Keep
    // the reference-identity edge case: a single/equal timestamp ends at now,
    // even if it has a resolved update. No upstream code is executed here.
    const first = updates.reduce((a, b) => b.chartOrder < a.chartOrder ? b : a);
    const last = updates.reduce((a, b) => b.chartOrder > a.chartOrder ? b : a);
    const chartInterval = { startedAt: first.at, endedAt: updates.some(update => update.status === 'resolved') && last !== first ? last.at : null };
    // Current state ordering must retain nanoseconds; chart Date values retain
    // the official millisecond precision, but must not choose current state.
    updates.sort((a, b) => a.seconds - b.seconds || a.nanos - b.nanos);
    const latest = updates.at(-1);
    return { id: text(item[0], 200), name: text(item[1], 1000), status: latest.status, impact: item[2] === 2 ? 'major' : 'minor', createdAt: updates[0].at, updatedAt: latest.at, body: latest.body,
      affectedComponents: [...new Set(item[5])].map(id => PRODUCTS[id] || 'Official product ' + id), productIds: [...new Set(item[5])], chartInterval };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = records.filter(item => item.status !== 'resolved');
  const ids = [...new Set([...Object.keys(PRODUCTS).map(Number), ...records.flatMap(item => item.productIds)])];
  const components = ids.map(id => {
    const affecting = active.filter(item => item.productIds.includes(id));
    return { id: String(id), name: PRODUCTS[id] || 'Official product ' + id, status: affecting.some(item => item.impact === 'major') ? 'major_outage' : affecting.length ? 'degraded_performance' : 'operational', updatedAt: affecting[0]?.updatedAt || '' };
  });
  const indicator = active.some(item => item.impact === 'major') ? 'major' : active.length ? 'minor' : 'none';
  const description = active.length ? 'Active incidents reported' : 'No active incidents reported';
  const cleanIncident = ({ productIds, chartInterval, ...item }) => item;
  const history = historyEnabled ? {
    available: true, stale: false, error: null, fetchedAt, sourceUrl: GEMINI_STATUS_URL, snapshotKind: 'official-incident-feed', rangeLabel: '90 days · All tiers',
    rows: components.map(component => ({ ...component, uptime: null, days: [], components: [] })),
    incidents: [], recentIncidents: records.slice(0, 10).map(cleanIncident),
    // All validated records, never just the ten recent ones. The shared browser
    // renderer applies the official local-day clipping and rounded-minute rule
    // to these official chart intervals. null ends at this fetched snapshot.
    chartIncidents: records.map(item => ({ ...cleanIncident(item), ...item.chartInterval })),
    metricsNote: 'Daily colors follow the official incident chart rules (All tiers, local calendar days). Green means no issues recorded, not measured availability. No uptime percentage has been estimated.',
    overall: { status: indicator === 'none' ? 'operational' : indicator === 'minor' ? 'degraded_performance' : 'major_outage', title: description, description: 'Reported by the official Gemini API and Google AI Studio incident feed. This is not an active probe of your account or channel.' }
  } : { available: false, stale: false, error: 'Historical data is unavailable.' };
  return { provider: 'gemini', name: 'Gemini', officialUrl: GEMINI_STATUS_URL, fetchedAt, sourceUpdatedAt: records[0]?.updatedAt || '', status: { indicator, description }, components, incidentsAvailable: true, incidents: active.map(cleanIncident), history };
}
export async function fetchGeminiSnapshot(upstream, now, historyEnabled = true) {
  const html = await upstream(GEMINI_STATUS_URL, 'text');
  const clientKeys = [...new Set(html.match(/AIza[0-9A-Za-z_-]{30,40}/g) || [])].slice(0, 4);
  if (!clientKeys.length) throw new Error('Official public status configuration unavailable');
  for (const clientKey of clientKeys) {
    let data;
    try {
      data = await upstream(GEMINI_INCIDENTS_RPC, 'json', { method: 'POST', body: '[]', headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-Api-Key': clientKey, Referer: 'https://aistudio.google.com/' } });
    } catch { continue; }
    // A successful response with an unknown schema is a failure, not permission
    // to try another configuration or report the service as healthy.
    return parseGeminiSnapshot(data, now(), historyEnabled);
  }
  throw new Error('Official Gemini status request failed');
}
