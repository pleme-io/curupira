import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { currentPosture, inWindow, isSignedOut, missingTabs, setPosture, warm } from '../warm/warm.js';

describe('warm', () => {
  afterEach(() => {
    delete process.env.CURUPIRA_POSTURE_FILE;
  });

  it('recognises sign-in pages by URL', () => {
    expect(isSignedOut('https://accounts.google.com/v3/signin/identifier?x')).toBe(true);
    expect(isSignedOut('https://splunk.example.invalid/en-US/account/login?return_to=/')).toBe(true);
    expect(isSignedOut('https://app.example.invalid/dashboard/abc')).toBe(false);
  });

  it('runs only inside the posture hours and days', () => {
    const tueNoon = new Date(2026, 9, 13, 12, 0);
    const sunNoon = new Date(2026, 9, 11, 12, 0);
    const tueNight = new Date(2026, 9, 13, 21, 0);
    expect(inWindow(tueNoon, [8, 19], [1, 2, 3, 4, 5])).toBe(true);
    expect(inWindow(sunNoon, [8, 19], [1, 2, 3, 4, 5])).toBe(false);
    expect(inWindow(tueNight, [8, 19], [1, 2, 3, 4, 5])).toBe(false);
    expect(inWindow(sunNoon)).toBe(true);
  });

  it('treats a tab as present when a page on the same host and first path segment is open', () => {
    const tabs = [
      { key: 'dd', url: 'https://app.example.invalid/monitors/manage?q=x' },
      { key: 'sp', url: 'https://logs.example.invalid/en-US/app/search/search?q=y' },
    ];
    const open = [{ id: '1', type: 'page', url: 'https://app.example.invalid/monitors/triggered' }];
    expect(missingTabs(tabs, open).map((t) => t.key)).toEqual(['sp']);
  });

  it('opens one tab per host and first path segment across workspaces', () => {
    const tabs = [
      { key: 'a', url: 'https://logs.example.invalid/en-US/app/search/x' },
      { key: 'b', url: 'https://logs.example.invalid/en-US/app/search/y' },
      { key: 'c', url: 'https://app.example.invalid/dashboard/1' },
    ];
    expect(missingTabs(tabs, []).map((t) => t.key)).toEqual(['a', 'c']);
  });

  it('persists the posture and does nothing when it is off', async () => {
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'posture-')), 'posture');
    expect(currentPosture()).toBe('off');
    setPosture('warm');
    expect(currentPosture()).toBe('warm');
    const r = await warm({ posture: 'off', port: 1, profile: '/nonexistent' });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('posture is off');
  });
});
