import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKimiSummary, parseKimiHistory } from './kimi.mjs';
// Synthetic fixtures are for tests only. Production always reads official sources.
export const kimiSummaryFixture = () => ({ page: { id: '10y9y5wx5xh3', url: 'https://status.moonshot.cn', updated_at: '2026-10-13T00:00:00Z' }, status: { indicator: 'none', description: 'All Systems Operational' }, components: [
  { id: 'kimi00000000', name: 'Kimi', group: true, status: 'operational' }, { id: 'saas00000000', name: 'SaaS', group: true, status: 'operational' }, { id: 'code00000000', name: 'Kimi Code', group: true, status: 'operational' },
  { id: 'api000000000', name: 'API Service', group_id: 'kimi00000000', status: 'operational' }, { id: 'open00000000', name: 'Open API', group_id: 'saas00000000', status: 'operational' }, { id: 'new000000000', name: 'New Model', group_id: 'code00000000', status: 'operational' }
], incidents: [] });
export const kimiHistoryFixture = () => ({ components: { open00000000: '<svg><rect class="uptime-day day-2" fill="#da9e11"/><rect class="uptime-day day-0" fill="#1e8542"/><rect class="uptime-day day-1" fill="#b3bac5"/></svg>', new000000000: '<svg><rect class="uptime-day day-0" fill="#b3bac5"/><rect class="uptime-day day-1" fill="#1e8542"/></svg>' }, values: [{ component: 'open00000000', ninety: 99.94 }, { component: 'new000000000', ninety: 100 }], timelines: { open00000000: { days: [{date:'2026-10-11',related_events:[]},{date:'2026-10-12',related_events:[]},{date:'2026-10-13',related_events:[{name:'官方事件',code:'event0000000'}]}] }, new000000000: {days:[{date:'2026-10-12'},{date:'2026-10-13'}]} } });
test('Kimi keeps distinct official groups and Open API versus API Service', () => { const s = parseKimiSummary(kimiSummaryFixture(), Date.now()); assert.equal(s.components.length,3); assert.deepEqual(s.components.map(c=>c.name),['API Service','Open API','New Model']); assert.equal(s.groups[2].name,'Kimi Code'); assert.equal(s.incidentsAvailable,true); });
test('Kimi official identity and missing data fail closed', () => {const s=kimiSummaryFixture();s.page.id='other';assert.throws(()=>parseKimiSummary(s,Date.now()));assert.throws(()=>parseKimiSummary({},Date.now()));assert.throws(()=>parseKimiHistory({},[]));});
test('Kimi preserves published percentages, SVG order, interpolated colors and dates without assuming Claude colors', () => { const s=parseKimiSummary(kimiSummaryFixture(),Date.now()),h=parseKimiHistory(kimiHistoryFixture(),s.components,s.groups),r=h.rows[1].components[0];assert.equal(r.uptime,'99.94');assert.deepEqual(r.days.map(d=>d.color),['#da9e11','#1e8542','#b3bac5']);assert.deepEqual(r.days.map(d=>d.date),['2026-10-13','2026-10-11','2026-10-12']);assert.deepEqual(r.days.map(d=>d.state),['official_history','operational','unknown']);assert.match(h.metricsNote,/regional coverage is not specified/); });
test('Kimi never fills in pre-registration history or missing charts, metrics or timeline dates', () => { const s=parseKimiSummary(kimiSummaryFixture(),Date.now()),d=kimiHistoryFixture();d.values=[];delete d.timelines;const h=parseKimiHistory(d,s.components,s.groups);assert.equal(h.rows[0].uptime,null);assert.equal(h.rows[0].components[0].days.length,0);assert.equal(h.rows[2].components[0].days.length,2);assert.equal(h.rows[2].components[0].days[0].state,'unknown');assert.equal(h.rows[2].components[0].uptime,null);assert.equal(h.rows[1].components[0].days[0].date,null); });
test('Kimi resolved events do not revive and non-English originals are disclosed instead of invented translations', () => {const d=kimiSummaryFixture();d.incidents=[{id:'one',name:'官方故障',status:'investigating',impact:'major',incident_updates:[{body:'调查中'}]},{id:'two',name:'Done',status:'resolved'}];const s=parseKimiSummary(d,Date.now());assert.equal(s.incidents.length,1);assert.equal(s.incidents[0].name,'Official incident one');assert.match(s.incidents[0].body,/not published in English/);assert.doesNotMatch(JSON.stringify(s),/[\u3400-\u9fff]/);const h=parseKimiHistory(kimiHistoryFixture(),s.components);assert.match(h.rows[1].days[0].events[0],/event0000000/);assert.doesNotMatch(JSON.stringify(h),/[\u3400-\u9fff]/);});
test('Kimi missing incident lists stay explicitly unavailable',()=>{const d=kimiSummaryFixture();delete d.incidents;assert.equal(parseKimiSummary(d,Date.now()).incidentsAvailable,false);});
test('Kimi keeps day.color for every official hex, including the operational green, so the view can match the official palette', () => {
  const s = parseKimiSummary(kimiSummaryFixture(), Date.now());
  const d = { components: { open00000000: '<svg><rect class="uptime-day day-0" fill="#1e8542"/><rect class="uptime-day day-1" fill="#da9e11"/><rect class="uptime-day day-2" fill="#b3bac5"/></svg>' }, values: [{ component: 'open00000000', ninety: 99.94 }], timelines: { open00000000: { days: [{date:'2026-10-11'},{date:'2026-10-12'},{date:'2026-10-13'}] } } };
  const days = parseKimiHistory(d, s.components, s.groups).rows[1].components[0].days;
  // The official operational green is #1e8542 (verified in the official Statuspage CSS); it must be
  // preserved verbatim, not replaced by a generic theme colour.
  assert.deepEqual(days.map(day => day.color), ['#1e8542', '#da9e11', '#b3bac5']);
  assert.deepEqual(days.map(day => day.state), ['operational', 'official_history', 'unknown']);
});
test('Kimi never maps an unknown or missing official colour to a healthy state', () => {
  const s = parseKimiSummary(kimiSummaryFixture(), Date.now());
  const d = { components: { open00000000: '<svg><rect class="uptime-day day-0" fill="#7c3aed"/><rect class="uptime-day day-1" fill="url(javascript:alert(1))"/><rect class="uptime-day day-2"/></svg>' }, values: [], timelines: { open00000000: { days: [{date:'2026-10-11'},{date:'2026-10-12'},{date:'2026-10-13'}] } } };
  const days = parseKimiHistory(d, s.components, s.groups).rows[1].components[0].days;
  assert.deepEqual(days.map(day => day.state), ['official_history', 'unknown', 'unknown']);
  assert.deepEqual(days.map(day => day.color), ['#7c3aed', null, null]);
  assert.ok(days.every(day => day.state !== 'operational'));
  assert.doesNotMatch(JSON.stringify(days), /javascript:/i);
});
