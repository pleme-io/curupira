import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BUDGET, budgetOf, closeCandidates, compileRoutes, keyOf, planTabs, readLedger, recordOpen, redirectTarget, type Ledger } from '../guard/tabs.js';
import { decideMemory, type MemorySample } from '../guard/memory.js';
import { applyBounded, boundWindow, type TimeWindow } from '../guard/window.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_CASES = path.resolve(here, '../../../crates/curupira-sites/fixtures/window-cases.json');

const SITES = [
  {
    id: 'dd',
    base_url: 'https://app.dd.invalid',
    match: ['app.dd.invalid'],
    tools: [
      { kind: 'goto', page: 'apm', url_template: 'https://app.dd.invalid/apm/home' },
      { kind: 'goto', page: 'dashboards', url_template: 'https://app.dd.invalid/dashboard/lists' },
      { kind: 'goto', page: 'dashboard', url_template: 'https://app.dd.invalid/dashboard/{id}' },
      { kind: 'goto', page: 'incidents', url_template: 'https://app.dd.invalid/incidents' },
    ],
  },
  {
    id: 'cd',
    base_url: 'https://cd.invalid',
    tools: [
      { kind: 'goto', page: 'applications', url_template: 'https://cd.invalid/applications?sync=&health=' },
      { kind: 'goto', page: 'unhealthy', url_template: 'https://cd.invalid/applications?sync=&health=Degraded' },
    ],
  },
];

const routes = compileRoutes(SITES);
const page = (id: string, url: string) => ({ id, type: 'page', url });
const emptyLedger = (): Ledger => ({ targets: {}, opens: {} });
const desired = [
  { key: 'apm', url: 'https://app.dd.invalid/apm/home', site: 'dd', page: 'apm' },
  { key: 'tenant', url: 'https://app.dd.invalid/dashboard/abc', site: 'dd', page: 'dashboard' },
  { key: 'gw', url: 'https://app.dd.invalid/dashboard/xyz', site: 'dd', page: 'dashboard' },
  { key: 'incidents', url: 'https://app.dd.invalid/incidents', site: 'dd', page: 'incidents' },
  { key: 'bad', url: 'https://cd.invalid/applications?sync=&health=Degraded', site: 'cd', page: 'unhealthy' },
  { key: 'status', url: 'https://status.invalid/' },
];
const plan = (open: ReturnType<typeof page>[], extra: Partial<Parameters<typeof planTabs>[0]> = {}) =>
  planTabs({ desired, open, ledger: emptyLedger(), routes, budget: DEFAULT_BUDGET, now: 1_000_000, closeDuplicates: true, ...extra });

describe('tab guard', () => {
  afterEach(() => {
    delete process.env.CURUPIRA_POSTURE_FILE;
  });

  it('keys a page by its site and page, the most specific route winning', () => {
    expect(keyOf('https://app.dd.invalid/dashboard/abc?from_ts=1&live=true', routes)).toBe('dd/dashboard');
    expect(keyOf('https://app.dd.invalid/dashboard/lists', routes)).toBe('dd/dashboards');
    expect(keyOf('https://cd.invalid/applications?sync=&health=Degraded&proj=', routes)).toBe('cd/unhealthy');
    expect(keyOf('https://cd.invalid/applications?sync=OutOfSync', routes)).toBe('cd/applications');
    expect(keyOf('https://app.dd.invalid/dashboard/abc?live=false&from_ts=1&to_ts=2', routes)).toBe('dd/dashboard');
    expect(keyOf('https://status.invalid/', routes)).toBe('status.invalid');
  });

  it('reads the page a sign-in redirect is holding', () => {
    expect(redirectTarget('https://app.dd.invalid/account/login?next=%2Fdashboard%2Fabc')).toBe('https://app.dd.invalid/dashboard/abc');
    expect(redirectTarget('https://og.invalid/auth/login?targetUri=%2Falert%2Flist')).toBe('https://og.invalid/alert/list');
    expect(redirectTarget('https://grafana.invalid/login')).toBeNull();
  });

  it('opens one tab per site and page, so two dashboards of one site share a tab', () => {
    const p = plan([]);
    expect(p.open.map((t) => t.key)).toEqual(['apm', 'tenant', 'incidents', 'bad', 'status']);
  });

  it('never reopens a page that sits on its sign-in redirect, and opens nothing more on a signed-out host', () => {
    const p = plan([page('L1', 'https://app.dd.invalid/account/login?next=%2Fdashboard%2Fabc')]);
    expect(p.present['dd/dashboard']).toBe('L1');
    expect(p.open.map((t) => t.key)).toEqual(['bad', 'status']);
    expect(p.signedOut).toEqual(['apm', 'incidents']);
    expect(p.signedOutHosts).toContain('app.dd.invalid');
  });

  it('keeps one sign-in tab per host and closes the pile the reopen loop left', () => {
    const pile = Array.from({ length: 35 }, (_, i) => page(`L${i}`, `https://app.dd.invalid/account/login?next=${encodeURIComponent(['/apm/home', '/incidents', '/dashboard/abc'][i % 3])}`));
    const p = plan([...pile, page('G1', 'https://grafana.invalid/login'), page('G2', 'https://grafana.invalid/login')]);
    expect(p.close.filter((c) => c.why === 'signed-out-duplicate')).toHaveLength(35);
    expect(p.pages).toBe(2);
    expect(p.open.map((t) => t.key)).toEqual(['bad', 'status']);
  });

  it('counts a tab curupira opened as present wherever it redirected, even to another host', () => {
    const ledger = emptyLedger();
    recordOpen(ledger, 'T1', desired[0], 'dd/apm', 1);
    const p = plan([page('T1', 'https://sso.invalid/u/login/identifier?state=x')], { ledger });
    expect(p.present['dd/apm']).toBe('T1');
    expect(p.signedOut).toContain('incidents');
  });

  it('closes a second tab curupira opened for one key, never a tab the operator opened', () => {
    const ledger = emptyLedger();
    recordOpen(ledger, 'A', desired[0], 'dd/apm', 1);
    recordOpen(ledger, 'B', desired[0], 'dd/apm', 2);
    const p = plan([page('A', 'https://app.dd.invalid/apm/home'), page('B', 'https://app.dd.invalid/apm/home'), page('U', 'https://app.dd.invalid/apm/home')], { ledger });
    expect(p.close.map((c) => c.id)).toEqual(['B']);
  });

  it('opens nothing past the tab budget and names what is over it', () => {
    const p = plan([page('x1', 'https://news.invalid/1'), page('x2', 'https://news.invalid/2')], { budget: { ...DEFAULT_BUDGET, max_tabs: 4 } });
    expect(p.open.map((t) => t.key)).toEqual(['apm', 'tenant']);
    expect(p.overBudget).toEqual(['incidents', 'bad', 'status']);
    const close = closeCandidates([page('x1', 'https://news.invalid/1')], p, routes, desired);
    expect(close[0]).toMatchObject({ id: 'x1', why: 'outside the requested set' });
  });

  it('stops reopening a key that keeps disappearing', () => {
    const ledger = emptyLedger();
    ledger.opens['dd/apm'] = [999_000, 999_500, 999_900];
    expect(plan([], { ledger }).flapping).toEqual(['apm']);
  });

  it('forgets ledger entries for tabs that are gone', () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'posture');
    const ledger = readLedger();
    recordOpen(ledger, 'gone', desired[0], 'dd/apm', 1);
    plan([], { ledger });
    expect(ledger.targets).toEqual({});
  });

  it('takes the budget from the bundle per field', () => {
    expect(budgetOf({ budget: { max_tabs: 12 } })).toEqual({ ...DEFAULT_BUDGET, max_tabs: 12 });
    expect(budgetOf(null)).toEqual(DEFAULT_BUDGET);
  });
});

describe('memory watchdog', () => {
  const sample = (tabs: Array<{ id: string; heap_mb?: number }>, rss?: number): MemorySample => ({
    at: 0,
    state: 'sampled',
    pages: tabs.length,
    tabs: tabs.map((t) => ({ id: t.id, url: `https://x.invalid/${t.id}`, state: t.heap_mb === undefined ? 'frozen' : 'sampled', heap_mb: t.heap_mb })),
    chrome: rss === undefined ? { state: 'blind' } : { state: 'sampled', rss_mb: rss },
  });

  it('reloads a tab over its budget once, then closes it if it grows back', () => {
    const s = sample([{ id: 'big', heap_mb: 2000 }, { id: 'ok', heap_mb: 50 }], 3000);
    expect(decideMemory(s, DEFAULT_BUDGET, {}, 10_000_000).map((a) => [a.id, a.kind, a.action])).toEqual([['big', 'tab-over', 'reload']]);
    expect(decideMemory(s, DEFAULT_BUDGET, { big: 9_999_000 }, 10_000_000)[0].action).toBe('close');
    expect(decideMemory(s, { ...DEFAULT_BUDGET, over: 'close' }, {}, 10_000_000)[0].action).toBe('close');
  });

  it('acts on the largest tab when Chrome as a whole is over budget, and says so when no tab answered', () => {
    const s = sample([{ id: 'a', heap_mb: 400 }, { id: 'b', heap_mb: 300 }], 9000);
    expect(decideMemory(s, DEFAULT_BUDGET, {}, 1).map((a) => [a.id, a.kind, a.action])).toEqual([['a', 'chrome-over', 'reload']]);
    const blind = decideMemory(sample([{ id: 'f' }], 9000), DEFAULT_BUDGET, {}, 1);
    expect(blind[0]).toMatchObject({ kind: 'chrome-over', action: 'none' });
  });

  it('does nothing under budget, when blind, or configured off', () => {
    expect(decideMemory(sample([{ id: 'a', heap_mb: 100 }], 2000), DEFAULT_BUDGET, {}, 1)).toEqual([]);
    expect(decideMemory({ ...sample([{ id: 'a', heap_mb: 9000 }]), state: 'blind' }, DEFAULT_BUDGET, {}, 1)).toEqual([]);
    expect(decideMemory(sample([{ id: 'a', heap_mb: 9000 }]), { ...DEFAULT_BUDGET, enabled: false }, {}, 1)).toEqual([]);
  });
});

describe('bounded time windows', () => {
  it('agrees with the Rust compiler on every shared case', () => {
    const cases = JSON.parse(fs.readFileSync(WINDOW_CASES, 'utf8')) as Array<{ name: string; window: TimeWindow; given: string | null; now_ms: number; expect: unknown }>;
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const c of cases) {
      const got = boundWindow(c.window, c.given ?? undefined, c.now_ms);
      expect('refused' in got ? null : got, c.name).toEqual(c.expect);
    }
  });

  it('fills a route and appends epoch bounds', () => {
    expect(applyBounded('https://s.invalid/search?q=x&earliest={earliest}', { substitute: { earliest: '-24h' }, append: {} })).toBe('https://s.invalid/search?q=x&earliest=-24h');
    expect(applyBounded('https://d.invalid/logs?query=a', { substitute: {}, append: { from_ts: '1', to_ts: '2' } })).toBe('https://d.invalid/logs?query=a&from_ts=1&to_ts=2');
  });
});
