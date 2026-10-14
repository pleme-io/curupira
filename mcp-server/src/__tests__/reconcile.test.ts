import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findStrays, mergeStrays, reconcileOnce, takeLease } from '../reconcile/reconcile.js';

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
});
