import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiSnapshot, fetchGeminiSnapshot, GEMINI_STATUS_URL, GEMINI_INCIDENTS_RPC } from './gemini.mjs';
// Synthetic RPC tuples are test fixtures, never a production status fallback.
const now = 1791891000000;
const update = (state, seconds, body = 'Official update') => [state, 'Official display date', [String(seconds)], body];
const incident = (id = 'fixture', state = 3, severity = 1, products = [1, 3]) => [id, 'Fixture incident', severity, [update(1, 1791800000), update(state, 1791803600)], 1, products];
const feed = (...incidents) => [[incidents]];

test('Gemini reads exact official incident text, product names and update timestamps', () => {
  const raw = incident(); raw[1] = '<script>upstream text</script>'; raw[3][1][3] = 'Official mitigation';
  const data = parseGeminiSnapshot(feed(raw), now);
  assert.equal(data.provider, 'gemini'); assert.equal(data.officialUrl, GEMINI_STATUS_URL);
  assert.equal(data.status.indicator, 'minor'); assert.equal(data.incidentsAvailable, true);
  assert.equal(data.incidents[0].name, raw[1]); assert.equal(data.incidents[0].body, 'Official mitigation');
  assert.deepEqual(data.incidents[0].affectedComponents, ['API', 'Google AI Studio']);
  assert.equal(data.incidents[0].updatedAt, new Date(1791803600000).toISOString());
  assert.notEqual(data.incidents[0].updatedAt, data.fetchedAt);
  assert.equal(data.components.find(c => c.id === '2').status, 'operational');
  assert.deepEqual(data.components.map(c => c.name), ['API', 'Multimodal Live API', 'Google AI Studio']);
});

test('Gemini resolved history does not revive active incidents or claim probed health', () => {
  const data = parseGeminiSnapshot(feed(incident('resolved', 4)), now);
  assert.deepEqual(data.incidents, []);
  assert.equal(data.status.description, 'No active incidents reported');
  assert.equal(data.history.overall.title, 'No active incidents reported');
  assert.match(data.history.overall.description, /not an active probe/);
  assert.equal(data.history.recentIncidents[0].status, 'resolved');
});

test('complete empty Gemini feed is distinct from malformed or missing incident data', () => {
  const data = parseGeminiSnapshot(feed(), now);
  assert.equal(data.incidentsAvailable, true); assert.deepEqual(data.incidents, []);
  for (const raw of [null, {}, [], [[]], [[null]], [[{}]]]) assert.throws(() => parseGeminiSnapshot(raw, now));
});

test('Gemini uses current worst severity, not a resolved historical outage', () => {
  const data = parseGeminiSnapshot(feed(incident('past', 4, 2), incident('current', 2, 1, [2])), now);
  assert.equal(data.status.indicator, 'minor');
  assert.equal(data.components.find(c => c.id === '1').status, 'operational');
  assert.equal(data.components.find(c => c.id === '2').status, 'degraded_performance');
  assert.equal(parseGeminiSnapshot(feed(incident('outage', 1, 2, [1])), now).status.indicator, 'major');
});

test('Gemini returns official chart inputs without manufacturing uptime or measured outage durations', () => {
  const data = parseGeminiSnapshot(feed(incident()), now);
  assert.equal(data.history.available, true); assert.equal(data.history.snapshotKind, 'official-incident-feed');
  assert.match(data.history.metricsNote, /official incident chart rules/);
  assert.match(data.history.metricsNote, /not measured availability/);
  assert.match(data.history.metricsNote, /No uptime percentage has been estimated/);
  for (const row of data.history.rows) { assert.equal(row.uptime, null); assert.deepEqual(row.days, []); }
  assert.equal(data.history.recentIncidents[0].durationText, undefined);
  assert.equal(data.history.recentIncidents[0].startedAt, undefined);
  assert.equal(data.sourceUpdatedAt, data.incidents[0].updatedAt);
});

test('Gemini selects the latest official update even when tuples are out of order', () => {
  const raw = incident('sorted', 4); raw[3].reverse();
  assert.deepEqual(parseGeminiSnapshot(feed(raw), now).incidents, []);
  const interval = parseGeminiSnapshot(feed(raw), now).history.chartIncidents[0];
  assert.equal(interval.startedAt, new Date(1791800000000).toISOString());
  assert.equal(interval.endedAt, new Date(1791803600000).toISOString());
});

test('Gemini unknown product IDs stay explicit instead of silently dropping scope', () => {
  const data = parseGeminiSnapshot(feed(incident('new-product', 1, 1, [4])), now);
  assert.deepEqual(data.incidents[0].affectedComponents, ['Official product 4']);
  assert.equal(data.components.find(c => c.id === '4').status, 'degraded_performance');
});

test('unknown Gemini schema, severity and timestamps fail closed', () => {
  for (const mutate of [i => { i[2] = 7; }, i => { i[3] = []; }, i => { i[3][1][0] = 99; }, i => { i[3][1][2] = ['invalid']; }, i => { i[3][1][2] = ['1791800000', -1]; }, i => { i[3][1][2] = ['1791800000', 1e9]; }, i => { i[5] = []; }, i => { i[5] = ['1']; }, i => { i[0] = ''; }]) {
    const raw = incident(); mutate(raw); assert.throws(() => parseGeminiSnapshot(feed(raw), now));
  }
});

test('Gemini uses only transient official client configuration and a fixed read-only RPC', async () => {
  const clientKey = 'AIza' + 'x'.repeat(35);
  const calls = [];
  const result = await fetchGeminiSnapshot(async (url, format, init) => {
    calls.push({ url, format, init });
    return format === 'text' ? '<html>Public client configuration ' + clientKey + '</html>' : feed(incident());
  }, () => now);
  assert.equal(calls[0].url, GEMINI_STATUS_URL);
  assert.equal(calls[1].url, GEMINI_INCIDENTS_RPC); assert.equal(calls[1].init.method, 'POST'); assert.equal(calls[1].init.body, '[]');
  assert.equal(calls[1].init.headers['X-Goog-Api-Key'], clientKey);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(clientKey));
});

test('Gemini configuration and request failures do not manufacture successful status', async () => {
  await assert.rejects(fetchGeminiSnapshot(async () => '<html>No public configuration</html>', () => now));
  const clientKey = 'AIza' + 'x'.repeat(35);
  await assert.rejects(fetchGeminiSnapshot(async (_, format) => { if (format === 'text') return clientKey; throw new Error('request failed'); }, () => now));
  await assert.rejects(fetchGeminiSnapshot(async (_, format) => format === 'text' ? clientKey : {}, () => now));
});

test('Gemini mitigated is not silently treated as resolved', () => {
  const data = parseGeminiSnapshot(feed(incident('mitigated', 5)), now);
  assert.equal(data.incidents[0].status, 'mitigated'); assert.equal(data.status.indicator, 'minor');
  assert.equal(data.history.chartIncidents[0].endedAt, null);
});

test('Gemini recent incident list is bounded and history disable does not disable current status', () => {
  const data = parseGeminiSnapshot(feed(...Array.from({length: 20}, (_, i) => incident(String(i), 4))), now);
  assert.equal(data.history.recentIncidents.length, 10);
  assert.equal(parseGeminiSnapshot(feed(incident()), now, false).history.available, false);
});

test('Gemini chart exposes every validated incident, not only the 10 recent ones', () => {
  const data = parseGeminiSnapshot(feed(...Array.from({length: 40}, (_, i) => incident('event-' + i, 4))), now);
  assert.equal(data.history.recentIncidents.length, 10); assert.equal(data.history.chartIncidents.length, 40);
  assert.equal(new Set(data.history.chartIncidents.map(event => event.id)).size, 40);
  for (const recent of data.history.recentIncidents) assert.ok(data.history.chartIncidents.some(event => event.id === recent.id));
  assert.equal(Object.hasOwn(data.history, 'timelineIncidents'), false, 'old first-report contract is retired');
});

test('Gemini chart events keep official severity and product scope without leaking private ordering fields', () => {
  const data = parseGeminiSnapshot(feed(incident('major-event', 2, 2, [1, 4])), now);
  const [{ startedAt, endedAt, ...event }] = data.history.chartIncidents;
  assert.equal(startedAt, new Date(1791800000000).toISOString()); assert.equal(endedAt, null);
  assert.equal(event.status, 'identified'); assert.equal(event.impact, 'major');
  assert.deepEqual(event.affectedComponents, ['API', 'Official product 4']);
  assert.equal(event.productIds, undefined); assert.equal(event.chartInterval, undefined); assert.equal(event.chartOrder, undefined);
  assert.deepEqual(event, data.history.recentIncidents[0]);
});

test('Gemini chart keeps resolved records without reviving current status', () => {
  const data = parseGeminiSnapshot(feed(incident('done', 4, 2)), now);
  assert.equal(data.history.chartIncidents.length, 1); assert.equal(data.history.chartIncidents[0].status, 'resolved');
  assert.equal(data.history.chartIncidents[0].impact, 'major');
  assert.deepEqual(data.incidents, []); assert.equal(data.status.indicator, 'none');
  assert.equal(data.components.every(component => component.status === 'operational'), true);
});

test('Gemini disabled or empty history never exposes fabricated chart records', () => {
  const disabled = parseGeminiSnapshot(feed(incident('live', 1, 2)), now, false);
  assert.equal(disabled.history.available, false); assert.equal(Object.hasOwn(disabled.history, 'chartIncidents'), false);
  assert.equal(Object.hasOwn(disabled.history, 'recentIncidents'), false);
  assert.equal(disabled.incidents.length, 1); assert.equal(disabled.status.indicator, 'major');
  const empty = parseGeminiSnapshot(feed(), now);
  assert.equal(empty.history.available, true); assert.deepEqual(empty.history.chartIncidents, []); assert.deepEqual(empty.history.recentIncidents, []);
});

test('Gemini chart is bounded by the validated official record cap', () => {
  const full = parseGeminiSnapshot(feed(...Array.from({length: 1000}, (_, i) => incident('event-' + i, 3))), now);
  assert.equal(full.history.chartIncidents.length, 1000); assert.equal(full.history.recentIncidents.length, 10);
  assert.throws(() => parseGeminiSnapshot(feed(...Array.from({length: 1001}, (_, i) => incident('event-' + i, 3))), now));
});

test('official chart ends at latest update only with any resolved state, independently of current status', () => {
  const raw = incident('reopened', 2);
  raw[3] = [update(1, 1791800000), update(4, 1791803600), update(2, 1791807200)];
  const data = parseGeminiSnapshot(feed(raw), now), chart = data.history.chartIncidents[0];
  assert.equal(data.incidents[0].status, 'identified');
  assert.equal(chart.endedAt, new Date(1791807200000).toISOString(), 'official chart takes maximum timestamp, not resolved timestamp');
  const ongoing = parseGeminiSnapshot(feed(incident('open', 3)), now).history.chartIncidents[0];
  assert.equal(ongoing.endedAt, null, 'unresolved chart continues to snapshot rather than last report');
});

test('official single and equal timestamp resolved chart cases continue to snapshot without reviving current status', () => {
  for (const updates of [[update(4, 1791800000)], [update(1, 1791800000), update(4, 1791800000)]]) {
    const raw = incident('single'); raw[3] = updates;
    const data = parseGeminiSnapshot(feed(raw), now);
    assert.deepEqual(data.incidents, []); assert.equal(data.history.chartIncidents[0].endedAt, null);
  }
});

test('official chart timestamp comparison follows protobuf string ordering instead of numeric inference', () => {
  const raw = incident('string-order', 4);
  raw[3] = [update(1, 999999999), update(4, 1000000000)];
  const chart = parseGeminiSnapshot(feed(raw), now).history.chartIncidents[0];
  assert.equal(chart.startedAt, new Date(1000000000000).toISOString());
  assert.equal(chart.endedAt, new Date(999999999000).toISOString());
  // This abnormal historical interval is not silently corrected: the browser
  // rejects reversed intervals, leaving history unavailable rather than green.
});

test('official timestamp conversion preserves protobuf nanoseconds down to Date millisecond precision', () => {
  const raw = incident('nanos', 4);
  raw[3][0][2] = ['1791800000', 123456789]; raw[3][1][2] = ['1791803600', 987654321];
  const chart = parseGeminiSnapshot(feed(raw), now).history.chartIncidents[0];
  assert.equal(chart.startedAt, new Date(1791800000123).toISOString());
  assert.equal(chart.endedAt, new Date(1791803600987).toISOString());
});

test('current state keeps nanosecond ordering even when chart Date timestamps share one millisecond', () => {
  for (const latestState of [1, 4]) {
    const latest = update(latestState, 1791800000); latest[2][1] = 900000;
    const older = update(latestState === 4 ? 1 : 4, 1791800000); older[2][1] = 100000;
    for (const updates of [[latest, older], [older, latest]]) {
      const raw = incident('sub-millisecond'); raw[3] = updates;
      const data = parseGeminiSnapshot(feed(raw), now);
      assert.equal(data.status.indicator, latestState === 4 ? 'none' : 'minor');
      assert.equal(data.incidents.length, latestState === 4 ? 0 : 1);
      assert.equal(data.history.recentIncidents[0].status, latestState === 4 ? 'resolved' : 'investigating');
      assert.equal(data.history.recentIncidents[0].updatedAt, new Date(1791800000000).toISOString());
    }
  }
});

test('Gemini chart groups by product-list field6 and defaults to all tiers, never by legacy service or tier-filtering', () => {
  const raw = incident('paid-only', 4, 1, [2, 3]); raw[4] = 1; raw[6] = [2];
  const chart = parseGeminiSnapshot(feed(raw), now).history.chartIncidents[0];
  assert.deepEqual(chart.affectedComponents, ['Multimodal Live API', 'Google AI Studio']);
});

test('Gemini adapter never executes official page scripts and only parses the fixed read-only payload', () => {
  const source = String(parseGeminiSnapshot) + String(fetchGeminiSnapshot);
  assert.doesNotMatch(source, /\beval\s*\(|\bFunction\s*\(|runInNewContext|import\s*\(/);
});
