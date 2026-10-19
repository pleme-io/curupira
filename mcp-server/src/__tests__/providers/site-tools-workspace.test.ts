import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Container } from '../../core/di/container.js';
import { createTestContainer, resetTestContainer } from '../test-container.js';
import { SiteToolProviderFactory } from '../../mcp/tools/providers/site-tools.factory.js';
import { LoggerToken, ValidatorToken } from '../../core/di/tokens.js';

const WORKSPACES = [
  {
    name: 'incident',
    description: 'outage set',
    tabs: [
      { key: 'logs', url: 'https://logs.example.invalid/app/search', site: 'logs', page: 'search' },
      { key: 'status', url: 'https://status.example.invalid' },
    ],
  },
];

function writeBundle(extra: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-ws-'));
  const p = path.join(dir, 'sites.bundle.json');
  fs.writeFileSync(p, JSON.stringify({ schema_version: 2, sites: [], ...extra }));
  return p;
}

function writeFakeStack(bundle: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-stack-'));
  const bin = path.join(dir, 'curupira-stack');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(bundle))});\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeProvider(container: Container, chromeService: unknown, bundlePath?: string) {
  return new SiteToolProviderFactory().create({
    chromeService,
    logger: container.resolve(LoggerToken),
    validator: container.resolve(ValidatorToken),
    ...(bundlePath ? { siteBundlePath: bundlePath } : {}),
  } as any);
}

const exec = (provider: any, tool: string, args: Record<string, unknown>) => provider.getHandler(tool)!.execute(args) as Promise<any>;

describe('site workspaces', () => {
  let container: Container;
  const saved = { ...process.env };

  beforeEach(() => {
    container = createTestContainer();
    process.env.CURUPIRA_POSTURE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-ws-state-')), 'posture');
    process.env.CURUPIRA_WORKSPACE_CHROME_PORT = '1';
  });
  afterEach(() => {
    resetTestContainer(container);
    for (const k of ['CURUPIRA_POSTURE_FILE', 'CURUPIRA_STACK_BIN', 'CURUPIRA_SITES_BUNDLE', 'CURUPIRA_SITES_SOURCE', 'CURUPIRA_WORKSPACE_CHROME_BIN', 'CURUPIRA_WORKSPACE_CHROME_PORT', 'CURUPIRA_WORKSPACE_CHROME_PROFILE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('opens one tab per workspace entry through Target.createTarget', async () => {
    const sent: Array<{ method: string; params: unknown }> = [];
    const client = {
      send: async (method: string, params: unknown) =>
        method === 'Target.getTargets' ? { targetInfos: [] } : (sent.push({ method, params }), { targetId: `t${sent.length}` }),
    };
    const provider = makeProvider(container, { getCurrentClient: () => client }, writeBundle({ workspaces: WORKSPACES }));
    const res = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(res.success).toBe(true);
    expect(sent).toEqual([
      { method: 'Target.createTarget', params: { url: 'https://logs.example.invalid/app/search' } },
      { method: 'Target.createTarget', params: { url: 'https://status.example.invalid' } },
    ]);
    expect(res.data.opened.map((o: any) => o.key)).toEqual(['logs', 'status']);
  });

  it('limits the set with `only` and reports a tab that failed without dropping the rest', async () => {
    const client = {
      send: async (m: string, p: { url: string }) => {
        if (m === 'Target.getTargets') return { targetInfos: [] };
        if (p.url.includes('status')) throw new Error('blocked');
        return { targetId: 'x' };
      },
    };
    const provider = makeProvider(container, { getCurrentClient: () => client }, writeBundle({ workspaces: WORKSPACES }));
    const all = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(all.success).toBe(false);
    expect(all.data.opened.map((o: any) => o.key)).toEqual(['logs']);
    expect(all.data.failed[0]).toMatchObject({ key: 'status', error: 'blocked' });
    const one = await exec(provider, 'site_workspace_open', { workspace: 'incident', only: ['logs'] });
    expect(one.success).toBe(true);
  });

  it('reuses an open tab for the same page, including one parked on its sign-in redirect, and opens only the rest', async () => {
    const sent: string[] = [];
    const infos = [{ targetId: 'L1', type: 'page', url: 'https://logs.example.invalid/account/login?next=%2Fapp%2Fsearch' }];
    const client = {
      send: async (m: string, p: { url: string }) => {
        if (m === 'Target.getTargets') return { targetInfos: infos };
        sent.push(p.url);
        infos.push({ targetId: `n${sent.length}`, type: 'page', url: p.url });
        return { targetId: `n${sent.length}` };
      },
    };
    const provider = makeProvider(container, { getCurrentClient: () => client }, writeBundle({ workspaces: WORKSPACES }));
    const res = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(res.success).toBe(true);
    expect(res.data.reused).toEqual([{ key: 'logs.example.invalid/app/search', targetId: 'L1' }]);
    expect(sent).toEqual(['https://status.example.invalid']);
    const again = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(again.data.opened).toEqual([]);
  });

  it('refuses past the tab budget with a typed answer naming what to close', async () => {
    const infos = Array.from({ length: 2 }, (_, i) => ({ targetId: `x${i}`, type: 'page', url: `https://news.example.invalid/${i}` }));
    const client = { send: async (m: string) => (m === 'Target.getTargets' ? { targetInfos: infos } : { targetId: 'n' }) };
    const provider = makeProvider(container, { getCurrentClient: () => client }, writeBundle({ workspaces: WORKSPACES, budget: { max_tabs: 3 } }));
    const res = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(res.success).toBe(false);
    expect(res.data.opened.map((o: any) => o.key)).toEqual(['logs']);
    expect(res.data.refused).toMatchObject({ outcome: 'refused', reason: 'tab-budget', max_tabs: 3, not_opened: ['status'] });
    expect(res.data.refused.close_first[0]).toMatchObject({ id: 'x0', why: 'outside the requested set' });
  });

  it('opens nothing when it cannot count the open tabs', async () => {
    const client = { send: async () => { throw new Error('no browser socket'); } };
    const provider = makeProvider(container, { getCurrentClient: () => client }, writeBundle({ workspaces: WORKSPACES }));
    const res = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(res.success).toBe(false);
    expect(res.data.outcome).toBe('blind');
  });

  it('launches a headed Chrome with every tab when none is connected or listening', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-chrome-'));
    const log = path.join(dir, 'argv.json');
    const bin = path.join(dir, 'chrome');
    fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    fs.chmodSync(bin, 0o755);
    process.env.CURUPIRA_WORKSPACE_CHROME_BIN = bin;
    process.env.CURUPIRA_WORKSPACE_CHROME_PORT = '1';
    process.env.CURUPIRA_WORKSPACE_CHROME_PROFILE = path.join(dir, 'profile');
    const provider = makeProvider(container, { getCurrentClient: () => null }, writeBundle({ workspaces: WORKSPACES }));
    const res = await exec(provider, 'site_workspace_open', { workspace: 'incident' });
    expect(res.data.launched.bin).toBe(bin);
    for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 100));
    const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
    expect(argv).toContain('--remote-debugging-port=1');
    expect(argv.slice(-2)).toEqual(['https://logs.example.invalid/app/search', 'https://status.example.invalid']);
  }, 40000);

  it('prefers the merged stack over the static bundle and lists its layers and refusals', async () => {
    process.env.CURUPIRA_STACK_BIN = writeFakeStack({
      schema_version: 2,
      sites: [],
      workspaces: WORKSPACES,
      stack: { layers: ['/u/curupira-sites.yaml', '/r/.curupira-sites.yaml'], refused: ["site 'ghost': missing"] },
    });
    process.env.CURUPIRA_SITES_BUNDLE = writeBundle({});
    const provider = makeProvider(container, { getCurrentClient: () => null });
    const res = await exec(provider, 'site_workspace_list', {});
    expect(res.data.layers).toEqual(['/u/curupira-sites.yaml', '/r/.curupira-sites.yaml']);
    expect(res.data.refused).toEqual(["site 'ghost': missing"]);
    expect(res.data.workspaces[0].name).toBe('incident');
  });

  it('falls back to the static bundle when the stack has no layers or is configured off', async () => {
    process.env.CURUPIRA_STACK_BIN = writeFakeStack({ schema_version: 2, sites: [], stack: { layers: [] } });
    process.env.CURUPIRA_SITES_BUNDLE = writeBundle({ workspaces: WORKSPACES });
    const empty = await exec(makeProvider(container, { getCurrentClient: () => null }), 'site_workspace_list', {});
    expect(empty.data.workspaces[0].name).toBe('incident');

    process.env.CURUPIRA_STACK_BIN = writeFakeStack({ schema_version: 2, sites: [], workspaces: [], stack: { layers: ['/x'] } });
    process.env.CURUPIRA_SITES_SOURCE = 'bundle';
    const off = await exec(makeProvider(container, { getCurrentClient: () => null }), 'site_workspace_list', {});
    expect(off.data.workspaces[0].name).toBe('incident');
  });
});
