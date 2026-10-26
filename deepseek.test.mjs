import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDeepSeekSummary, parseDeepSeekHistory, parseEnglishText } from './deepseek.mjs';

/**
 * SYNTHETIC FIXTURES ONLY.
 *
 * Every value below is invented for these tests (synthetic ids, uptimes, names and
 * timestamps); nothing here is copied from the live https://status.deepseek.com payload.
 * The markup mimics the official Flashduty Next.js structure closely enough to exercise
 * the adapter's selectors, but it is not official data.
 */

const SYNTHETIC_IDS = {
  apiPrimary: 'synth-comp-api-primary', apiFlash: 'synth-comp-api-flash',
  chat: 'synth-comp-chat', upload: 'synth-comp-upload', search: 'synth-comp-search',
  chatSection: 'synth-section-chat'
};

function bars(count, fill) {
  return Array.from({ length: count }, (_, i) =>
    `<rect x="${i * 6.5}" y="0" width="5" height="16" rx="2" ry="2" fill="${fill}" opacity="1" class="transition"></rect>`).join('');
}

function rowBody({ name, dot = 'bg-green-500', uptime = '98.10', omitUptime = false, chart = true, dayCount = 90, fill = '#22c55e' }) {
  const header = '<div class="flex items-center justify-between gap-2">'
    + '<div class="flex items-center gap-2 min-w-0">'
    + `<div class="flex items-center justify-center rounded-full shrink-0 ${dot} h-4 w-4" aria-hidden="true">`
    + '<svg class="lucide lucide-check text-white h-2.5 w-2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></div>'
    + '<div class="flex items-center gap-1.5 min-w-0">'
    + `<span class="font-medium text-sm truncate">${name}</span>`
    + '<span role="button" class="inline-flex items-center justify-center size-5 rounded-sm" aria-label="View description">'
    + '<svg class="lucide lucide-info h-3.5 w-3.5" aria-hidden="true"><path d="M12 16v-4"></path></svg></span>'
    + '</div></div>'
    + (omitUptime ? '' : `<div class="text-sm text-muted-foreground shrink-0 whitespace-nowrap">${uptime}% uptime</div>`)
    + '</div>';
  const chartMarkup = chart
    ? `<div class="hidden sm:block"><svg width="100%" height="16" viewBox="0 0 583.5 16" preserveAspectRatio="none" class="mt-3 cursor-pointer touch-none">${bars(dayCount, fill)}</svg></div>`
    : '';
  return header + chartMarkup;
}

function plainRow(options) {
  return `<div class="p-4">${rowBody(options)}</div>`;
}

function sectionGroup({ name, dot, uptime, dayCount, fill, children }) {
  const button = '<button class="w-full p-4 hover:bg-muted/5 transition-colors text-left">'
    + rowBody({ name, dot, uptime, dayCount, fill }) + '</button>';
  const inner = children.map(child => `<div class="px-4 pb-4">${rowBody(child)}</div>`).join('');
  return `<div class="w-full">${button}<div class="overflow-hidden transition-all duration-300" style="max-height:0px;opacity:0"><div>${inner}</div></div></div>`;
}

function overallCard({ title = 'Everything is running smoothly', description = 'All systems are operating as expected.', dot = 'bg-green-500' } = {}) {
  return '<div hidden="" id="S:5"><div class="space-y-2">'
    + '<div class="border text-card-foreground bg-emerald-100 border-none p-1 rounded-xl overflow-hidden">'
    + '<div class="p-4 pt-3"><h2 class="font-medium flex items-center gap-2">'
    + `<div class="flex items-center justify-center rounded-full shrink-0 ${dot} h-4 w-4" aria-hidden="true">`
    + '<svg class="lucide lucide-check text-white h-2.5 w-2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg></div>'
    + `${title}</h2>${description ? `<p class="text-sm text-muted-foreground mt-1 ml-6">${description}</p>` : ''}`
    + '</div><div class="space-y-px rounded-lg overflow-hidden"></div></div></div></div>';
}

function systemCard({ groups, rangeLabel = 'Jul 2026 - Oct 2026' } = {}) {
  return '<div hidden="" id="S:6"><div class="rounded-xl border text-card-foreground overflow-hidden border-none bg-muted/80 p-1 pt-0">'
    + '<div class="p-4 py-3.5 flex items-center justify-between bg-muted/5"><h2 class="font-medium">System status</h2>'
    + '<div class="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">'
    + '<button aria-label="Previous period"><svg class="lucide lucide-chevron-left h-4 w-4" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg></button>'
    + (rangeLabel ? `<span class="min-w-[150px] text-center">${rangeLabel}</span>` : '')
    + '<button aria-label="Next period" disabled=""><svg class="lucide lucide-chevron-right h-4 w-4" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg></button>'
    + `</div></div><div class="divide-y bg-background rounded-lg divide-muted/80">${groups.join('')}</div></div></div>`;
}

const SYNTHETIC_MESSAGES = {
  status: {
    operational: 'All Systems Operational', operationalDesc: 'All services are running normally',
    degraded: 'Degraded Performance', degradedDesc: 'Some services are experiencing degraded performance',
    partial_outage: 'Partial Outage', partial_outageDesc: 'Some services are experiencing issues',
    full_outage: 'Full Outage', full_outageDesc: 'Critical services are down',
    maintenance: 'Under Maintenance', maintenanceDesc: 'Scheduled maintenance in progress'
  },
  incident: { title: 'Incident', maintenance: 'Maintenance', investigating: 'Investigating', resolved: 'Resolved' }
};

function flight(lines) {
  return lines.map(line => `<script>self.__next_f.push([1,${JSON.stringify(line)}])</script>`).join('');
}

function defaultFlight({ activeChanges = [], withActiveChanges = true, activeChangesRaw = null, extraScripts = '' } = {}) {
  const summary = activeChangesRaw !== null
    ? `"active_changes":${activeChangesRaw}`
    : (withActiveChanges ? `"active_changes":${JSON.stringify(activeChanges)}` : '');
  const dataLine = '1e:["$","$L23",null,{"pageId":900001,"initialData":'
    + '{'
    + '"page":' + JSON.stringify({
      page_id: 900001, name: 'DeepSeek', type: 'public',
      components: [
        { component_id: SYNTHETIC_IDS.apiPrimary, name: 'DeepSeek V4 Pro API服务(API Service)', order_id: 1 },
        { component_id: SYNTHETIC_IDS.apiFlash, name: 'DeepSeek V4.1 Flash API服务(API Service)', order_id: 2 },
        { component_id: SYNTHETIC_IDS.chat, section_id: SYNTHETIC_IDS.chatSection, name: '对话服务(Chatservice)', order_id: 1 },
        { component_id: SYNTHETIC_IDS.upload, section_id: SYNTHETIC_IDS.chatSection, name: '上传文件服务(File Upload Service)', order_id: 2 },
        { component_id: SYNTHETIC_IDS.search, section_id: SYNTHETIC_IDS.chatSection, name: '搜索服务(Search Service)', order_id: 3 }
      ],
      sections: [{ section_id: SYNTHETIC_IDS.chatSection, name: '对话服务(Chat Service)', order_id: 3 }]
    })
    + (summary ? `,${summary}` : '')
    + '},"initialDataUpdatedAt":1791891253859}]';
  const messagesLine = 'b:["$","$L14",null,' + JSON.stringify({ locale: 'en', messages: SYNTHETIC_MESSAGES }) + ']';
  const seriesLine = '22:["$","$L25",null,{"initialData":' + JSON.stringify({
    section_impacts: [], section_uptimes: [], component_impacts: [], component_uptimes: [], linked_changes: []
  }) + '}]';
  return flight([messagesLine, dataLine, seriesLine]) + extraScripts;
}

function syntheticHtml({
  overall = {}, groups, rangeLabel = 'Jul 2026 - Oct 2026', activeChanges = [],
  withActiveChanges = true, activeChangesRaw = null, extraScripts = ''
} = {}) {
  const defaultGroups = [
    plainRow({ name: 'DeepSeek V4 Pro API服务(API Service)', uptime: '98.10', dayCount: 90 }),
    plainRow({ name: 'DeepSeek V4.1 Flash API服务(API Service)', uptime: '97.50', dayCount: 90 }),
    sectionGroup({
      name: '对话服务(Chat Service)', uptime: '99.00', dayCount: 90,
      children: [
        { name: '对话服务(Chatservice)', uptime: '96.40', dayCount: 90 },
        { name: '上传文件服务(File Upload Service)', uptime: '100.00', dayCount: 90 },
        { name: '搜索服务(Search Service)', uptime: '95.25', dayCount: 90 }
      ]
    })
  ];
  return '<!doctype html><html><head><title>DeepSeek Status</title></head><body>'
    + overallCard(overall) + systemCard({ groups: groups ?? defaultGroups, rangeLabel })
    + defaultFlight({ activeChanges, withActiveChanges, activeChangesRaw, extraScripts })
    + '</body></html>';
}

const activeIncident = {
  change_id: 9001000000001, type: 'incident', status: 'monitoring',
  title: 'DeepSeek API 性能下降（DeepSeek API Degraded Performance）',
  description: '正在监控恢复情况。\n\nMonitoring recovery.',
  start_at_seconds: 1791787000, close_at_seconds: null,
  affected_components: [{ component_id: SYNTHETIC_IDS.apiFlash, name: 'DeepSeek V4.1 Flash API服务(API Service)', status: 'degraded' }],
  updates: [
    { update_id: 'synth-up-1', at_seconds: 1791787000, status: 'investigating', description: '正在排查问题。\n\nThe issue is being investigated.' },
    { update_id: 'synth-up-2', at_seconds: 1791787400, status: 'monitoring', description: '正在监控恢复情况。\n\nMonitoring recovery.' }
  ]
};

test('parseEnglishText prefers the official English line of official bilingual text', () => {
  assert.equal(parseEnglishText('正在监控恢复情况。\n\nMonitoring recovery.'), 'Monitoring recovery.');
  // Reversed order: English first, Chinese only inside the parenthetical.
  assert.equal(parseEnglishText('API Service（接口服务）'), 'API Service');
});

test('parseEnglishText keeps brand tokens hidden in the Chinese half of inline bilingual names', () => {
  assert.equal(parseEnglishText('DeepSeek V4 Pro API服务(API Service)'), 'DeepSeek V4 Pro API Service');
  assert.equal(parseEnglishText('DeepSeek V4.1 Flash API服务(API Service)'), 'DeepSeek V4.1 Flash API Service');
  // The two API rows must never collapse to the same "(API Service)" label.
  assert.notEqual(
    parseEnglishText('DeepSeek V4 Pro API服务(API Service)'),
    parseEnglishText('DeepSeek V4.1 Flash API服务(API Service)')
  );
});

test('parseEnglishText returns null for Chinese-only text instead of inventing a translation', () => {
  assert.equal(parseEnglishText('搜索服务异常'), null);
  assert.equal(parseEnglishText('本次问题已解决，服务已恢复。'), null);
  assert.equal(parseEnglishText(''), null);
});

test('parseEnglishText strips markup so official text can never inject HTML', () => {
  const adversarial = [
    '<img src=x onerror=alert(1)>Service restored',
    '<script>alert(1)</script>Degraded performance',
    '<b>Monitoring</b> recovery',
    'Service <svg onload=alert(1)> restored'
  ];
  for (const value of adversarial) {
    const result = parseEnglishText(value);
    if (result === null) continue;
    assert.equal(typeof result, 'string');
    assert.doesNotMatch(result, /[<>]/, `angle brackets survived: ${result}`);
    assert.doesNotMatch(result, /<[a-z/]/i);
  }
});

test('summary normalizes to the shared status shape with official English labels', () => {
  const data = parseDeepSeekSummary(syntheticHtml(), 1791900000000);
  assert.equal(data.provider, 'deepseek');
  assert.equal(data.name, 'DeepSeek');
  assert.equal(data.officialUrl, 'https://status.deepseek.com');
  assert.equal(data.fetchedAt, new Date(1791900000000).toISOString());
  assert.equal(data.sourceUpdatedAt, new Date(1791891253859).toISOString());
  assert.deepEqual(Object.keys(data.status), ['indicator', 'description']);
  assert.equal(data.status.indicator, 'none');
  assert.equal(data.status.description, 'Everything is running smoothly');
});

test('summary lists the leaf components with official English names and distinct official ids', () => {
  const data = parseDeepSeekSummary(syntheticHtml());
  assert.deepEqual(data.components.map(component => component.name), [
    'DeepSeek V4 Pro API Service', 'DeepSeek V4.1 Flash API Service',
    'Chatservice', 'File Upload Service', 'Search Service'
  ]);
  assert.deepEqual(data.components.map(component => component.id), [
    SYNTHETIC_IDS.apiPrimary, SYNTHETIC_IDS.apiFlash, SYNTHETIC_IDS.chat, SYNTHETIC_IDS.upload, SYNTHETIC_IDS.search
  ]);
  assert.equal(new Set(data.components.map(component => component.id)).size, data.components.length);
  assert.ok(data.components.every(component => component.status === 'operational'));
  assert.ok(data.components.every(component => component.updatedAt === ''));
  assert.ok(data.components.every(component => Object.keys(component).join() === 'id,name,status,updatedAt'));
});

test('summary treats an explicit empty official active-change list as authoritative', () => {
  const data = parseDeepSeekSummary(syntheticHtml({ activeChanges: [], withActiveChanges: true }));
  assert.equal(data.incidentsAvailable, true);
  assert.deepEqual(data.incidents, []);
  assert.equal(data.status.indicator, 'none');
});

test('summary never revives resolved or completed official changes as active incidents', () => {
  const resolved = { ...activeIncident, change_id: 9001000000002, status: 'resolved', close_at_seconds: 1791789000 };
  const completed = { ...activeIncident, change_id: 9001000000003, type: 'maintenance', status: 'completed' };
  const data = parseDeepSeekSummary(syntheticHtml({ activeChanges: [resolved, completed] }));
  assert.deepEqual(data.incidents, []);
  assert.equal(data.incidentsAvailable, true);
});

test('summary exposes an active official incident with official English body text', () => {
  const data = parseDeepSeekSummary(syntheticHtml({ activeChanges: [activeIncident] }));
  assert.equal(data.incidents.length, 1);
  const [incident] = data.incidents;
  assert.equal(incident.id, '9001000000001');
  assert.equal(incident.name, 'DeepSeek API Degraded Performance');
  assert.equal(incident.status, 'monitoring');
  assert.equal(incident.impact, 'minor');
  assert.equal(incident.body, 'Monitoring recovery.');
  assert.equal(incident.createdAt, new Date(1791787000 * 1000).toISOString());
  assert.equal(incident.updatedAt, new Date(1791787400 * 1000).toISOString());
  assert.deepEqual(incident.affectedComponents, ['DeepSeek V4.1 Flash API Service']);
  assert.doesNotMatch(JSON.stringify(incident), /正在监控|\u6b63\u5728/);
});

test('summary throws instead of reporting a healthy status for an unknown official status', () => {
  const html = syntheticHtml({ overall: { dot: 'bg-purple-500', title: 'Mystery state' } });
  assert.throws(() => parseDeepSeekSummary(html), /Unexpected official DeepSeek overall status/);
});

test('summary throws when the official active-change summary is missing or not an array', () => {
  assert.throws(() => parseDeepSeekSummary(syntheticHtml({ withActiveChanges: false })), /active change summary missing/);
  assert.throws(() => parseDeepSeekSummary(syntheticHtml({ activeChangesRaw: 'null' })), /active change summary missing/);
  assert.throws(() => parseDeepSeekSummary(syntheticHtml({ activeChanges: [{ change_id: 1 }] })), /active change schema changed/);
});

test('summary surfaces an unrecognized official component severity as unknown, never healthy', () => {
  const groups = [
    plainRow({ name: '对话服务(Chatservice)', dot: 'bg-purple-500', uptime: '98.10' }),
    plainRow({ name: '搜索服务(Search Service)', dot: 'bg-green-500', uptime: '99.10' })
  ];
  const data = parseDeepSeekSummary(syntheticHtml({ groups }));
  assert.equal(data.components[0].status, 'unknown');
  assert.equal(data.components[1].status, 'operational');
});

test('summary and history never execute embedded upstream scripts, including eval', () => {
  delete globalThis.__deepseekPwned;
  delete globalThis.__deepseekEvalRan;
  const extraScripts = '<script>globalThis.__deepseekPwned = true; throw new Error("must not run");</script>'
    + '<script>eval("globalThis.__deepseekEvalRan = true");</script>'
    + '<script>self.__next_f.push([1,"{not json"])</script>';
  const html = syntheticHtml({ extraScripts });
  const data = parseDeepSeekSummary(html);
  const history = parseDeepSeekHistory(html, data.components);
  assert.equal(data.provider, 'deepseek');
  assert.equal(history.available, true);
  assert.equal(globalThis.__deepseekPwned, undefined);
  assert.equal(globalThis.__deepseekEvalRan, undefined);
  assert.equal(typeof globalThis.eval, 'function');
});

test('the adapter source contains no eval, vm or Function constructor execution path', () => {
  const source = readFileSync(new URL('./deepseek.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /node:vm|runInNewContext|runInThisContext/);
  assert.doesNotMatch(source, /new\s+Function\s*\(/);
});

test('history maps official bars in DOM order and keeps official percentage strings verbatim', () => {
  const data = parseDeepSeekSummary(syntheticHtml());
  const history = parseDeepSeekHistory(syntheticHtml(), data.components);
  assert.equal(history.available, true);
  assert.equal(history.sourceUrl, 'https://status.deepseek.com');
  assert.equal(history.snapshotKind, 'official-html');
  assert.equal(history.rangeLabel, 'Jul 2026 - Oct 2026');
  assert.deepEqual(history.rows.map(row => row.name), ['DeepSeek V4 Pro API Service', 'DeepSeek V4.1 Flash API Service', 'Chat Service']);
  // "100.00" must survive as the official string, not be parsed into 100.
  assert.deepEqual(history.rows.map(row => row.uptime), ['98.10', '97.50', '99.00']);
  assert.equal(history.rows[2].components[1].uptime, '100.00');
  assert.equal(history.rows[2].components[1].uptime.length, 6);
});

test('history keeps parent and children series separate and counts children', () => {
  const data = parseDeepSeekSummary(syntheticHtml());
  const history = parseDeepSeekHistory(syntheticHtml(), data.components);
  const section = history.rows[2];
  assert.equal(section.componentCount, 3);
  assert.equal(section.days.length, 90);
  assert.equal(section.components.length, 3);
  assert.ok(section.components.every(child => child.days.length === 90));
  assert.deepEqual(section.components.map(child => child.name), ['Chatservice', 'File Upload Service', 'Search Service']);
  assert.ok(section.components.every(child => child.components.length === 0));
  // Child bars must not leak into the parent series.
  assert.equal(section.days.length, section.components[0].days.length);
  assert.ok(history.rows.slice(0, 2).every(row => row.days.length === 90 && row.components.length === 0));
});

test('history maps the official SVG palette to states and preserves every official fill as color', () => {
  const groups = [plainRow({ name: '对话服务(Chatservice)', dayCount: 90, fill: '#22c55e' })];
  const html = syntheticHtml({ groups });
  // Rewrite a deterministic slice of the synthetic palette to the other official fills.
  const patched = html
    .replace('<rect x="0" y="0" width="5" height="16" rx="2" ry="2" fill="#22c55e"', '<rect x="0" y="0" width="5" height="16" rx="2" ry="2" fill="#eab308"')
    .replace('<rect x="6.5" y="0" width="5" height="16" rx="2" ry="2" fill="#22c55e"', '<rect x="6.5" y="0" width="5" height="16" rx="2" ry="2" fill="#f97316"')
    .replace('<rect x="13" y="0" width="5" height="16" rx="2" ry="2" fill="#22c55e"', '<rect x="13" y="0" width="5" height="16" rx="2" ry="2" fill="#ef4444"')
    .replace('<rect x="19.5" y="0" width="5" height="16" rx="2" ry="2" fill="#22c55e"', '<rect x="19.5" y="0" width="5" height="16" rx="2" ry="2" fill="#3b82f6"')
    .replace('<rect x="26" y="0" width="5" height="16" rx="2" ry="2" fill="#22c55e"', '<rect x="26" y="0" width="5" height="16" rx="2" ry="2" fill="#123456"');
  const history = parseDeepSeekHistory(patched, parseDeepSeekSummary(patched).components);
  const days = history.rows[0].days;
  assert.deepEqual(days.slice(0, 5).map(day => day.state), ['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance', 'official_history']);
  // Every official fill survives verbatim as day.color so the view can match the official palette.
  assert.deepEqual(days.slice(0, 5).map(day => day.color), ['#eab308', '#f97316', '#ef4444', '#3b82f6', '#123456']);
  assert.deepEqual(days.slice(5).map(day => day.color), Array(85).fill('#22c55e'));
  assert.equal(days.length, 90);
  assert.ok(days.every(day => day.date === null));
  assert.ok(days.every(day => Object.keys(day).join() === 'state,color,date,events'));
  assert.ok(days.every(day => Array.isArray(day.events) && day.events.length === 0));
});

test('history keeps an unrecognized but verified official hex as official_history, never healthy', () => {
  const groups = [plainRow({ name: '对话服务(Chatservice)', dayCount: 90, fill: '#7c3aed' })];
  const html = syntheticHtml({ groups });
  const history = parseDeepSeekHistory(html, parseDeepSeekSummary(html).components);
  const days = history.rows[0].days;
  assert.ok(days.every(day => day.state === 'official_history'));
  assert.ok(days.every(day => day.color === '#7c3aed'));
  // An unknown official colour must never be reported as a healthy state.
  assert.ok(days.every(day => day.state !== 'operational'));
});

test('history never uses a non-hex fill as a style and never maps a missing fill to healthy', () => {
  const groups = [plainRow({ name: '对话服务(Chatservice)', dayCount: 90, fill: 'url(javascript:alert(1))' })];
  const html = syntheticHtml({ groups });
  const history = parseDeepSeekHistory(html, parseDeepSeekSummary(html).components);
  const days = history.rows[0].days;
  // An unsafe or missing official fill is unknown with no colour, and never a healthy state.
  assert.ok(days.every(day => day.state === 'unknown'));
  assert.ok(days.every(day => day.color === null));
  assert.doesNotMatch(JSON.stringify(history), /javascript:/i);
});

test('history reports a missing official uptime as null instead of estimating one', () => {
  const groups = [
    plainRow({ name: '对话服务(Chatservice)', uptime: '96.40' }),
    plainRow({ name: '搜索服务(Search Service)', omitUptime: true })
  ];
  const html = syntheticHtml({ groups });
  const history = parseDeepSeekHistory(html, parseDeepSeekSummary(html).components);
  assert.equal(history.rows[0].uptime, '96.40');
  assert.equal(history.rows[1].uptime, null);
  assert.equal(history.rows[1].days.length, 90);
});

test('a broken history layout throws for history without invalidating the summary', () => {
  const html = syntheticHtml({ rangeLabel: '' });
  const summary = parseDeepSeekSummary(html);
  assert.equal(summary.components.length, 5);
  assert.equal(summary.status.indicator, 'none');
  assert.throws(() => parseDeepSeekHistory(html, summary.components), /history layout changed/);
});

test('history rejects a page whose official series are missing', () => {
  const groups = [plainRow({ name: '对话服务(Chatservice)', chart: false, uptime: '96.40' })];
  const html = syntheticHtml({ groups });
  assert.throws(() => parseDeepSeekHistory(html, []), /history missing/);
});

test('history attaches official ids from the flight payload and the supplied components', () => {
  const html = syntheticHtml();
  const summary = parseDeepSeekSummary(html);
  const history = parseDeepSeekHistory(html, summary.components);
  assert.equal(history.rows[0].id, SYNTHETIC_IDS.apiPrimary);
  assert.equal(history.rows[2].id, SYNTHETIC_IDS.chatSection);
  assert.deepEqual(history.rows[2].components.map(child => child.id), [SYNTHETIC_IDS.chat, SYNTHETIC_IDS.upload, SYNTHETIC_IDS.search]);
});

test('summary rejects empty or non-markup input instead of inventing a healthy page', () => {
  assert.throws(() => parseDeepSeekSummary(''), /markup missing/);
  assert.throws(() => parseDeepSeekSummary(null), /markup missing/);
  assert.throws(() => parseDeepSeekHistory('<html><body>no components</body></html>'), /layout changed/);
});
