import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PINNED_PROFILE, profileVerdict, refusal, verdictOf } from '../guard/profile.js';
import { DEFAULT_BUDGET, planTabs } from '../guard/tabs.js';
import { ensureChrome } from '../warm/warm.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function userDataDir(localState?: unknown | string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-profile-'));
  dirs.push(d);
  if (localState !== undefined) fs.writeFileSync(path.join(d, 'Local State'), typeof localState === 'string' ? localState : JSON.stringify(localState));
  return d;
}

const cache = (entries: Record<string, { user_name?: string; name?: string }>) => ({ profile: { info_cache: entries } });

const THREE = cache({
  Default: { user_name: 'operator@work.invalid', name: 'work' },
  'Profile 1': { user_name: 'personal@home.invalid', name: 'personal' },
  'Profile 2': { user_name: 'other@home.invalid', name: 'other' },
});

describe('profileVerdict', () => {
  it('a directory Chrome has not populated yet is fresh', () => {
    expect(profileVerdict(userDataDir())).toEqual({ outcome: 'fresh' });
    expect(profileVerdict(userDataDir({}))).toEqual({ outcome: 'fresh' });
    expect(profileVerdict(userDataDir(cache({})))).toEqual({ outcome: 'fresh' });
  });

  it('one profile is pinned', () => {
    const v = profileVerdict(userDataDir(cache({ Default: { user_name: 'operator@work.invalid', name: 'work' } })));
    expect(v).toEqual({ outcome: 'pinned', profiles: [{ dir: 'Default', account: 'operator@work.invalid', name: 'work' }] });
  });

  it('more than one profile is refused, naming every extra and what to do', () => {
    const dir = userDataDir(THREE);
    const v = profileVerdict(dir);
    expect(v.outcome).toBe('refused');
    if (v.outcome !== 'refused') return;
    expect(v.reason).toBe('multiple-profiles');
    expect(v.profiles.map((p) => p.dir)).toEqual(['Default', 'Profile 1', 'Profile 2']);
    expect(v.extra.map((p) => p.dir)).toEqual(['Profile 1', 'Profile 2']);
    expect(v.next).toContain(dir);
    expect(v.next).toContain("'Profile 1', 'Profile 2'");
    expect(v.next).toContain('never deletes');
  });

  it('two profiles with no Default are refused with every profile extra', () => {
    const v = verdictOf(cache({ 'Profile 1': { user_name: 'a@x.invalid' }, 'Profile 2': { user_name: 'b@x.invalid' } }), '/d');
    expect(v.outcome).toBe('refused');
    if (v.outcome === 'refused') expect(v.extra.map((p) => p.dir)).toEqual(['Profile 1', 'Profile 2']);
  });

  it('a profile signed out of Chrome is listed as such, not skipped', () => {
    const v = verdictOf(cache({ Default: {}, 'Profile 1': { user_name: 'a@x.invalid' } }), '/d');
    expect(v.outcome).toBe('refused');
    expect(refusal(v)).toContain('Default=signed out');
  });

  it('an unreadable or unparseable Local State is blind, never pinned', () => {
    const v = profileVerdict(userDataDir('{not json'));
    expect(v.outcome).toBe('blind');
    expect(refusal(v)).toBeNull();
  });
});

describe('refusal', () => {
  it('speaks only for a refused verdict', () => {
    expect(refusal({ outcome: 'fresh' })).toBeNull();
    expect(refusal({ outcome: 'pinned', profiles: [] })).toBeNull();
    expect(refusal({ outcome: 'blind', reason: 'x' })).toBeNull();
    const text = refusal(verdictOf(THREE, '/d'));
    expect(text).toContain('refused: multiple-profiles');
    expect(text).toContain('nothing was driven');
  });
});

describe('planTabs under a refused profile', () => {
  const desired = [{ key: 'a', url: 'https://a.invalid/x' }];
  const open = [{ id: '1', type: 'page', url: 'https://a.invalid/x' }, { id: '2', type: 'page', url: 'https://a.invalid/x' }];
  const base = { desired, open, ledger: { targets: {}, opens: {} }, routes: [], budget: DEFAULT_BUDGET, now: 0, closeDuplicates: true };

  it('opens nothing and closes nothing, and says why', () => {
    const profile = verdictOf(THREE, '/d');
    const plan = planTabs({ ...base, profile });
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([]);
    expect(plan.pages).toBe(2);
    expect(plan.profile).toBe(profile);
  });

  it('plans exactly as before for a pinned, fresh, blind or absent verdict', () => {
    const baseline = planTabs({ ...base, ledger: { targets: {}, opens: {} } });
    for (const profile of [undefined, { outcome: 'fresh' as const }, { outcome: 'pinned' as const, profiles: [] }, { outcome: 'blind' as const, reason: 'x' }]) {
      const plan = planTabs({ ...base, ledger: { targets: {}, opens: {} }, profile });
      expect(plan.open).toEqual(baseline.open);
      expect(plan.close).toEqual(baseline.close);
    }
  });
});

describe('ensureChrome', () => {
  it('will not launch Chrome against a directory holding several profiles', async () => {
    const r = await ensureChrome(1, userDataDir(THREE), '/usr/bin/true');
    expect(r.launched).toBe(false);
    expect(r.error).toContain('refused: multiple-profiles');
  });

  it('pins the profile it launches', () => {
    expect(PINNED_PROFILE).toBe('Default');
  });
});
