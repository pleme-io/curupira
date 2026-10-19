import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findStrays, lastReport, mergeStrays, reconcileOnce, reportFile, takeLease } from '../reconcile/reconcile.js';
import { setPosture } from '../warm/warm.js';
import { fakeDevtools } from './helpers/fake-devtools.js';

const DD = {
  id: 'dd',
  base_url: 'https://app.dd.invalid',
  match: ['app.dd.invalid'],
  tools: [
    { kind: 'goto', page: 'apm', url_template: 'https://app.dd.invalid/apm/home' },
    { kind: 'goto', page: 'dashboard', url_template: 'https://app.dd.invalid/dashboard/{id}' },
    { kind: 'goto', page: 'incidents', url_template: 'https://app.dd.invalid/incidents' },
  ],
};

function stackWith(bundle: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-stack-'));
  const bin = path.join(dir, 'curupira-stack');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(bundle))});\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function posture(budget: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    sites: [DD],
    budget,
    workspaces: [
      {
        name: 'oncall',
        tabs: [
          { key: 'apm', url: 'https://app.dd.invalid/apm/home', site: 'dd', page: 'apm' },
          { key: 'tenant', url: 'https://app.dd.invalid/dashboard/abc', site: 'dd', page: 'dashboard' },
          { key: 'gateway', url: 'https://app.dd.invalid/dashboard/xyz', site: 'dd', page: 'dashboard' },
          { key: 'incidents', url: 'https://app.dd.invalid/incidents', site: 'dd', page: 'incidents' },
          { key: 'status', url: 'https://status.example.invalid/' },
        ],
      },
    ],
    postures: [{ name: 'warm', workspaces: ['oncall'], interval_minutes: 30, reconcile: { tick_seconds: 60, tabs: 'enforce', strays: 'question' } }],
  };
}

const page = (id: string, url: string) => ({ id, type: 'page', url });

describe('reconcile', () => {
  afterEach(() => {
    delete process.env.CURUPIRA_POSTURE_FILE;
  });

  it('questions only tabs on hosts outside the posture, never built-ins, allowed or sign-in pages', () => {
    const desired = [{ key: 'logs', url: 'https://logs.example.invalid/en-US/app/search' }];
    const open = [
      page('1', 'https://logs.example.invalid/en-US/app/other'),
      page('2', 'https://news.example.invalid/today'),
      page('3', 'chrome://newtab/'),
      page('4', 'https://accounts.google.com/v3/signin/identifier'),
      page('5', 'https://wiki.example.invalid/page'),
      { id: '6', type: 'service_worker', url: 'https://sw.example.invalid/' },
    ];
    expect(findStrays(open, desired, ['wiki.example.invalid']).map((t) => t.id)).toEqual(['2']);
  });

  it('asks once per stray, keeps an adopted one, forgets one that closed', () => {
    const first = mergeStrays({}, [page('2', 'https://news.example.invalid/a'), page('3', 'https://news.example.invalid/b')], 1);
    expect(first.fresh).toEqual(['news.example.invalid']);
    const again = mergeStrays(first.book, [page('2', 'https://news.example.invalid/a')], 2);
    expect(again.fresh).toEqual([]);
    expect(again.book['news.example.invalid'].first_seen).toBe(1);
    again.book['news.example.invalid'].verdict = 'adopted';
    const gone = mergeStrays({ ...again.book, 'old.example.invalid': { ...again.book['news.example.invalid'], host: 'old.example.invalid', verdict: 'questioned' } }, [], 3);
    expect(Object.keys(gone.book)).toEqual(['news.example.invalid']);
  });

  it('a signed-out console stays one tab across ticks instead of reopening every tick', async () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'posture');
    setPosture('warm');
    const chrome = await fakeDevtools((u) => (u.includes('app.dd.invalid') ? `https://app.dd.invalid/account/login?next=${encodeURIComponent(new URL(u).pathname)}` : u));
    try {
      const stackBin = stackWith(posture());
      const states: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await reconcileOnce({ port: chrome.port, stackBin, now: new Date(Date.UTC(2026, 9, 19, 12, i)) });
        states.push(r.state);
      }
      expect(chrome.created.length).toBeLessThanOrEqual(4);
      expect(chrome.targets.map((t) => t.url).sort()).toEqual([
        expect.stringContaining('https://app.dd.invalid/account/login?next='),
        'https://status.example.invalid/',
      ]);
      const last = lastReport();
      expect(last?.state).toBe('limited');
      expect(last?.signedOutHosts).toContain('app.dd.invalid');
      expect(last?.opened).toEqual([]);
      expect(states.at(-1)).toBe('limited');
    } finally {
      await chrome.close();
    }
  }, 30000);

  it('caps opened tabs at the budget and reports the rest', async () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'posture');
    setPosture('warm');
    const chrome = await fakeDevtools();
    try {
      const r = await reconcileOnce({ port: chrome.port, stackBin: stackWith(posture({ max_tabs: 2 })), now: new Date(Date.UTC(2026, 9, 19, 12, 0)) });
      expect(r.opened, JSON.stringify(r)).toEqual(['apm', 'tenant']);
      expect(r.overBudget).toEqual(['incidents', 'status']);
      expect(chrome.targets).toHaveLength(2);
      const again = await reconcileOnce({ port: chrome.port, stackBin: stackWith(posture({ max_tabs: 2 })), now: new Date(Date.UTC(2026, 9, 19, 12, 1)) });
      expect(again.opened).toEqual([]);
      expect(again.state).toBe('limited');
    } finally {
      await chrome.close();
    }
  }, 30000);

  it('reloads a tab over its memory budget, then closes it when it grows back', async () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'posture');
    const chrome = await fakeDevtools();
    chrome.targets.push({ id: 'big', type: 'page', url: 'https://logs.example.invalid/search', heapMb: 4000 });
    try {
      const stackBin = stackWith({ schema_version: 2, sites: [], budget: { tab_memory_mb: 1000, chrome_memory_mb: 100000 } });
      const first = await reconcileOnce({ port: chrome.port, stackBin, now: new Date(Date.UTC(2026, 9, 19, 12, 0)) });
      expect(first.memory?.events.map((e) => [e.id, e.kind, e.action])).toEqual([['big', 'tab-over', 'reloaded']]);
      chrome.targets[0].heapMb = 4000;
      const second = await reconcileOnce({ port: chrome.port, stackBin, now: new Date(Date.UTC(2026, 9, 19, 12, 2)) });
      expect(second.memory?.events.map((e) => [e.id, e.action])).toEqual([['big', 'closed']]);
      expect(chrome.targets).toHaveLength(0);
    } finally {
      await chrome.close();
    }
  }, 30000);

  it('lets one curupira hold the reconcile lease at a time', () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'posture');
    const lease = path.join(path.dirname(process.env.CURUPIRA_POSTURE_FILE), 'reconcile.lease');
    fs.writeFileSync(lease, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    expect(takeLease(60)).toBe(false);
    fs.writeFileSync(lease, JSON.stringify({ pid: process.ppid, at: Date.now() - 600000 }));
    expect(takeLease(60)).toBe(true);
  });

  it('does nothing when the posture is off', async () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'posture');
    const r = await reconcileOnce({ port: 1 });
    expect(r.state).toBe('idle');
    expect(r.reason).toBe('posture is off');
  });

  it('records an idle tick, so an old converged report never stands for the present', async () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'posture');
    fs.writeFileSync(reportFile(), JSON.stringify({ at: 1, posture: 'warm', state: 'converged' }));
    const r = await reconcileOnce({ port: 1 });
    expect(lastReport()).toEqual(r);
    expect(lastReport()?.state).toBe('idle');
  });
});
