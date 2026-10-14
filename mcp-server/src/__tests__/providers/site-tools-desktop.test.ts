import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Container } from '../../core/di/container.js';
import { createTestContainer, resetTestContainer } from '../test-container.js';
import { ROUTE_NEXT, SiteToolProviderFactory, routeQuery, substituteSteps } from '../../mcp/tools/providers/site-tools.factory.js';
import { ChromeServiceToken, LoggerToken, ValidatorToken } from '../../core/di/tokens.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

function desktopSite() {
  return {
    id: 'example-system-settings',
    target: 'desktop',
    app: 'System Settings',
    bundle_id: 'com.apple.systempreferences',
    tier: 'full',
    why: 'no stable AX tree yet',
    promote: 'example-system-settings-ax',
    tools: [
      {
        name: 'example_system_settings_wifi_goto',
        description: 'Plan bringing System Settings to the wifi view',
        kind: 'goto',
        page: 'wifi',
        json_schema: { ...NO_ARGS, required: [] },
        desktop: { op: 'ready', ready: ['Wi-Fi'] },
      },
      {
        name: 'example_system_settings_wifi_read_networks',
        description: "Plan reading 'networks'",
        kind: 'read',
        page: 'wifi',
        json_schema: NO_ARGS,
        desktop: { op: 'read', region: 'right pane, the list under Known Networks' },
      },
      {
        name: 'example_system_settings_wifi_act_find',
        description: "Plan 'find'",
        kind: 'act',
        page: 'wifi',
        json_schema: NO_ARGS,
        desktop: { op: 'act', steps: ['key cmd+f', 'type {query}', 'wait 1'], params: ['query'] },
        effect: 'observe',
        describes: '',
      },
      {
        name: 'example_system_settings_wifi_act_forget',
        description: 'MUTATES the host: forgets a network',
        kind: 'act',
        page: 'wifi',
        json_schema: NO_ARGS,
        desktop: { op: 'act', steps: ["click 'Forget'"] },
        effect: 'mutate',
        describes: 'forgets a network',
      },
    ],
  };
}

function browserSite() {
  return {
    id: 'fixture',
    target: 'browser',
    base_url: 'https://console.example.invalid',
    match: ['console.example.invalid'],
    tools: [
      { name: 'fixture_home_goto', description: '', kind: 'goto', page: 'home', json_schema: NO_ARGS, js: 'R', url_template: 'https://console.example.invalid/home' },
      { name: 'fixture_home_read_title', description: '', kind: 'read', page: 'home', json_schema: NO_ARGS, js: 'T' },
    ],
  };
}

function appSite() {
  return {
    id: 'example-calculator',
    target: 'macos-app',
    bundle_id: 'com.apple.calculator',
    tools: [{ name: 'example_calculator_keypad_goto', description: '', kind: 'goto', page: 'keypad', json_schema: NO_ARGS, ax: { op: 'ready', ready: [] } }],
    tests: [{ name: 't', view: 'keypad', ready: [], read_checks: [] }],
  };
}

const bundle = (sites: unknown[]) => ({ schema_version: 2, sites }) as any;

function writeBundle(sites: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-sites-'));
  const p = path.join(dir, 'sites.bundle.json');
  fs.writeFileSync(p, JSON.stringify(bundle(sites)));
  return p;
}

const exec = (provider: any, tool: string, args: Record<string, unknown>) => provider.getHandler(tool)!.execute(args) as Promise<any>;

describe('site tools on a desktop target', () => {
  let container: Container;
  let provider: any;
  let cdpCalls: number;

  beforeEach(() => {
    container = createTestContainer();
    cdpCalls = 0;
    const chrome = { getCurrentClient: () => { cdpCalls += 1; return null; } };
    provider = new SiteToolProviderFactory().create({
      chromeService: chrome ?? container.resolve(ChromeServiceToken),
      logger: container.resolve(LoggerToken),
      validator: container.resolve(ValidatorToken),
      siteBundlePath: writeBundle([browserSite(), appSite(), desktopSite()]),
    } as any);
  });
  afterEach(() => resetTestContainer(container));

  it('goto plans opening the app and names the ready texts, without touching CDP', async () => {
    const res = await exec(provider, 'site_goto', { site: 'example-system-settings', page: 'wifi' });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      driver: 'computer-use',
      site: 'example-system-settings',
      app: 'System Settings',
      bundleId: 'com.apple.systempreferences',
      tier: 'full',
      view: 'wifi',
      kind: 'goto',
      ready: ['Wi-Fi'],
      steps: ['open System Settings', 'screenshot'],
      then: 'verify with screenshot that every ready text is visible',
    });
    expect(cdpCalls).toBe(0);
  });

  it('read plans a screenshot of the named region', async () => {
    const res = await exec(provider, 'site_read', { site: 'example-system-settings', page: 'wifi', region: 'networks' });
    expect(res.data).toMatchObject({ driver: 'computer-use', region: 'right pane, the list under Known Networks', steps: ['screenshot'], ready: ['Wi-Fi'] });
    expect(cdpCalls).toBe(0);
  });

  it('act substitutes params into the steps', async () => {
    const res = await exec(provider, 'site_act', { site: 'example-system-settings', page: 'wifi', control: 'find', params: { query: 'Home' } });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ kind: 'act', control: 'find', steps: ['key cmd+f', 'type Home', 'wait 1'], then: 'verify with screenshot that every ready text is visible' });
    expect(cdpCalls).toBe(0);
  });

  it('act names the missing params', async () => {
    const res = await exec(provider, 'site_act', { site: 'example-system-settings', page: 'wifi', control: 'find' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/needs params: query/);
  });

  it('a mutate act still requires authorized_by', async () => {
    const refused = await exec(provider, 'site_act', { site: 'example-system-settings', page: 'wifi', control: 'forget' });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/MUTATES the host \(forgets a network\)/);
    const granted = await exec(provider, 'site_act', { site: 'example-system-settings', page: 'wifi', control: 'forget', authorized_by: 'yes, forget it' });
    expect(granted.success).toBe(true);
    expect(granted.data.steps).toEqual(["click 'Forget'"]);
  });

  it('site_list shows the desktop target and its why', async () => {
    const res = await exec(provider, 'site_list', {});
    expect(res.data.sites[2]).toMatchObject({ id: 'example-system-settings', target: 'desktop', app: 'System Settings', tier: 'full', why: 'no stable AX tree yet', promote: 'example-system-settings-ax', mutating: 1 });
    expect(res.data.sites[2].baseUrl).toBeUndefined();
  });

  it('site_context lists the desktop target with its driver and never matches a tab to it', async () => {
    const res = await exec(provider, 'site_context', {});
    expect(res.data.nativeTargets).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'example-system-settings', target: 'desktop', driver: 'computer-use', app: 'System Settings' })]),
    );
  });

  it('site_route answers through the tool', async () => {
    const res = await exec(provider, 'site_route', { query: 'system settings' });
    expect(res.data.matches[0]).toMatchObject({ site: 'example-system-settings', driver: 'computer-use' });
    expect((await exec(provider, 'site_route', { query: ' ' })).success).toBe(false);
  });
});

describe('routeQuery', () => {
  const b = bundle([browserSite(), appSite(), desktopSite()]);

  it('routes a URL to the browser profile by host', () => {
    expect(routeQuery(b, 'https://console.example.invalid/home?x=1')).toEqual({
      query: 'https://console.example.invalid/home?x=1',
      matches: [{ site: 'fixture', target: 'browser', driver: 'curupira-cdp', tools: ['site_context', 'site_goto', 'site_read'], pages: ['home'] }],
      unmatched: false,
    });
  });

  it('routes a bundle id to the macos-app profile with its suite runner', () => {
    expect(routeQuery(b, 'com.apple.calculator').matches).toEqual([
      { site: 'example-calculator', target: 'macos-app', driver: 'curupira-ax', tools: ['site_goto', 'site_run_tests'], views: ['keypad'] },
    ]);
  });

  it('routes an app name to the desktop profile with the computer-use tools and the promotion', () => {
    expect(routeQuery(b, 'SYSTEM SETTINGS').matches).toEqual([
      {
        site: 'example-system-settings',
        target: 'desktop',
        driver: 'computer-use',
        tools: ['site_goto', 'site_read', 'site_act', 'mcp__computer-use__request_access', 'mcp__computer-use__open_application', 'mcp__computer-use__screenshot'],
        views: ['wifi'],
        promote: 'example-system-settings-ax',
      },
    ]);
  });

  it('ranks an exact id above a host above a name', () => {
    const sites = [
      { ...desktopSite(), id: 'console-notes', app: 'Notes' },
      browserSite(),
      { ...appSite(), id: 'console' },
    ];
    expect(routeQuery(bundle(sites), 'console').matches.map((m) => m.site)).toEqual(['console', 'fixture', 'console-notes']);
  });

  it('matches a view name', () => {
    expect(routeQuery(b, 'wifi').matches.map((m) => m.site)).toEqual(['example-system-settings']);
  });

  it('answers unmatched as a typed result naming how to map it', () => {
    expect(routeQuery(b, 'Photoshop')).toEqual({ query: 'Photoshop', matches: [], unmatched: true, next: ROUTE_NEXT });
    expect(ROUTE_NEXT).toBe(
      'map it: browser → curupira-sites draft <url>; native → curupira-ax survey <bundle_id>; else declare a desktop profile',
    );
  });
});

describe('substituteSteps', () => {
  it('fills placeholders and names missing ones', () => {
    expect(substituteSteps(['type {a} {b}'], { a: 'x', b: 'y' })).toEqual({ ok: true, steps: ['type x y'] });
    expect(substituteSteps(['type {a} {b}'], { a: 'x' })).toEqual({ ok: false, missing: ['b'] });
  });
});
