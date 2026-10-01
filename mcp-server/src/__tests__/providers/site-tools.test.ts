/**
 * Site-plugin provider tests.
 *
 * These verify the parts that CANNOT be checked on the Rust side, because they
 * are properties of the host integration rather than of the compiler: that a
 * bundle turns into registered tools, that a missing or wrong-version bundle
 * degrades safely, and — the one that matters — that the borrowed-ground gate
 * holds before anything touches the browser.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Container } from '../../core/di/container.js';
import { createTestContainer, resetTestContainer } from '../test-container.js';
import { SiteToolProviderFactory } from '../../mcp/tools/providers/site-tools.factory.js';
import { ChromeServiceToken, LoggerToken, ValidatorToken } from '../../core/di/tokens.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

/** A minimal bundle in exactly the shape `curupira-sites build` writes. */
function bundle(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sites: [
      {
        id: 'fixture',
        base_url: 'https://console.example.invalid',
        match: ['console.example.invalid'],
        tools: [
          {
            name: 'fixture_home_goto',
            description: "Navigate to the 'home' page",
            kind: 'goto',
            page: 'home',
            json_schema: { ...NO_ARGS, required: [] },
            js: 'HOME_READY',
            url_template: 'https://console.example.invalid/home',
          },
          {
            name: 'fixture_home_read_title',
            description: "Read 'title' on the 'home' page",
            kind: 'read',
            page: 'home',
            json_schema: NO_ARGS,
            js: '(() => ({ status: "found", value: "hi" }))()',
          },
          {
            name: 'fixture_home_act_delete',
            description: 'MUTATES the host: destroys everything',
            kind: 'act',
            page: 'home',
            json_schema: {
              type: 'object',
              properties: { authorized_by: { type: 'string', minLength: 1 } },
              required: ['authorized_by'],
              additionalProperties: false,
            },
            js: '(() => true)()',
            effect: 'mutate',
            describes: 'destroys everything',
          },
          {
            name: 'fixture_cluster_detail_goto',
            description: "Navigate to the 'cluster-detail' page",
            kind: 'goto',
            page: 'cluster-detail',
            json_schema: {
              type: 'object',
              properties: { cluster_id: { type: 'string' } },
              required: ['cluster_id'],
              additionalProperties: false,
            },
            js: 'CLUSTER_READY',
            url_template: 'https://console.example.invalid/clusters/{cluster_id}',
          },
          {
            name: 'fixture_cluster_detail_read_pods',
            description: "Read 'pods' on the 'cluster-detail' page",
            kind: 'read',
            page: 'cluster-detail',
            json_schema: NO_ARGS,
            js: 'READ_PODS',
          },
        ],
        tests: [{ name: 'home renders', route: '/home', survey_js: 'SURVEY' }],
      },
    ],
    ...overrides,
  };
}

function secondSite() {
  return {
    id: 'other-console',
    base_url: 'https://other.example.invalid',
    match: ['other.example.invalid'],
    tools: [
      'alpha',
      'beta',
      'gamma',
    ].flatMap((page) => [
      {
        name: `other_console_${page}_goto`,
        description: `Navigate to the '${page}' page`,
        kind: 'goto',
        page,
        json_schema: { ...NO_ARGS, required: [] },
        js: `${page.toUpperCase()}_READY`,
        url_template: `https://other.example.invalid/${page}`,
      },
      ...['rows_0', 'rows_1', 'heading'].map((region) => ({
        name: `other_console_${page}_read_${region}`,
        description: `Read '${region}' on the '${page}' page`,
        kind: 'read',
        page,
        json_schema: NO_ARGS,
        js: `READ_${page}_${region}`,
      })),
    ]),
  };
}

function writeBundle(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-sites-'));
  const p = path.join(dir, 'sites.bundle.json');
  fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return p;
}

function makeProvider(
  container: Container,
  bundlePath: string,
  opts: { perPageTools?: boolean; chromeService?: unknown } = {},
) {
  return new SiteToolProviderFactory().create({
    chromeService: opts.chromeService ?? container.resolve(ChromeServiceToken),
    logger: container.resolve(LoggerToken),
    validator: container.resolve(ValidatorToken),
    siteBundlePath: bundlePath,
    sitePerPageTools: opts.perPageTools,
  } as any);
}

function fakeBrowser(startHref: string) {
  const sent: Array<{ method: string; params: any }> = [];
  let href = startHref;
  const client = {
    send: async (method: string, params: any) => {
      sent.push({ method, params });
      if (method === 'Page.navigate') {
        href = params.url;
        return { frameId: 'f' };
      }
      const expr = String(params?.expression ?? '');
      if (expr === 'window.location.href') return { result: { value: href } };
      if (expr.startsWith('[window.location.href')) return { result: { value: `${href}||complete` } };
      return { result: { value: { evaluated: expr } } };
    },
  };
  return { sent, service: { getCurrentClient: () => client } };
}

const names = (provider: any): string[] => provider.listTools().map((t: any) => t.name).sort();
const tool = (provider: any, name: string): any => provider.listTools().find((t: any) => t.name === name);

describe('SiteToolProvider', () => {
  let container: Container;

  beforeEach(() => {
    container = createTestContainer();
  });
  afterEach(() => {
    resetTestContainer(container);
    delete process.env.CURUPIRA_SITES_PER_PAGE_TOOLS;
  });

  it('registers the per-page tools when they are configured on', () => {
    const provider = makeProvider(container, writeBundle(bundle()), { perPageTools: true });
    const names = provider.listTools().map((t: any) => t.name);
    expect(names).toContain('site_context');
    expect(names).toContain('site_list');
    expect(names).toContain('fixture_home_read_title');
    expect(names).toContain('fixture_home_act_delete');
    expect(names).toContain('fixture_run_tests');
  });

  it('always emits a real JSON Schema', () => {
    // Without one the base provider substitutes {additionalProperties:true},
    // which advertises that a tool accepts anything and turns what should be a
    // schema rejection into a runtime failure.
    for (const perPageTools of [false, true]) {
      const provider = makeProvider(container, writeBundle(bundle()), { perPageTools });
      for (const t of provider.listTools()) {
        expect(t.inputSchema, `${t.name} has no inputSchema`).toBeDefined();
        expect((t.inputSchema as any).type).toBe('object');
      }
    }
  });

  it('refuses a mutating tool with no grant, AT THE HANDLER', async () => {
    // The JSON Schema already marks authorized_by required, which stops a
    // well-behaved caller. This is the second line: it stops every caller,
    // including one that reaches the handler by another route. On borrowed
    // ground the cost of a missed check has no undo, so it is checked twice.
    const provider = makeProvider(container, writeBundle(bundle()), { perPageTools: true });
    const res = await provider.getHandler('fixture_home_act_delete')!.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/MUTATES the host/);
    expect(res.error).toMatch(/authorized_by/);
  });

  it('names what the control does in the refusal', async () => {
    // Whoever is being asked to grant needs to know what they are approving.
    const provider = makeProvider(container, writeBundle(bundle()), { perPageTools: true });
    const res = await provider.getHandler('fixture_home_act_delete')!.execute({});
    expect(res.error).toMatch(/destroys everything/);
  });

  it('treats a missing bundle as normal, not as an error', () => {
    // Most installs have no profiles. Registering only the context tools is the
    // correct behaviour, and it must not throw during container construction.
    const provider = makeProvider(container, path.join(os.tmpdir(), 'definitely-absent.json'));
    const names = provider.listTools().map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['site_context', 'site_list']));
    expect(names).toHaveLength(2);
  });

  it('refuses a bundle whose schema version it does not understand', () => {
    // Reading unknown fields as if they were known is worse than not loading:
    // it produces tools that look right and behave arbitrarily.
    const provider = makeProvider(container, writeBundle(bundle({ schema_version: 99 })));
    expect(provider.listTools()).toHaveLength(2);
  });

  it('survives a corrupt bundle without taking the server down', () => {
    const provider = makeProvider(container, writeBundle('{ not json'));
    expect(provider.listTools()).toHaveLength(2);
  });

  it('reports every loaded site through site_list', async () => {
    const provider = makeProvider(container, writeBundle(bundle()));
    const res = await provider.getHandler('site_list')!.execute({}) as any;
    expect(res.success).toBe(true);
    expect(res.data.sites[0]).toMatchObject({ id: 'fixture', tools: 5, mutating: 1 });
    expect(res.data.sites[0].pages).toEqual([
      { page: 'home', regions: ['title'], controls: ['delete'], params: [] },
      { page: 'cluster-detail', regions: ['pods'], controls: [], params: ['cluster_id'] },
    ]);
  });

  describe('generic site tools', () => {
    it('registers a fixed set of generic tools and no per-page tools by default', () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      expect(names(provider)).toEqual([
        'site_act',
        'site_context',
        'site_goto',
        'site_list',
        'site_read',
        'site_run_tests',
      ]);
    });

    it('does not grow the tool count with the number of sites and pages', () => {
      const one = makeProvider(container, writeBundle(bundle()));
      const b = bundle();
      const two = makeProvider(container, writeBundle({ ...b, sites: [...b.sites, secondSite()] }));
      expect(names(two)).toEqual(names(one));
    });

    it('reads the per-page switch from the environment when the caller does not set it', () => {
      process.env.CURUPIRA_SITES_PER_PAGE_TOOLS = 'true';
      const provider = makeProvider(container, writeBundle(bundle()));
      expect(names(provider)).toContain('fixture_home_read_title');
    });

    it('registers only the generic tools that have a legal target', () => {
      const provider = makeProvider(container, writeBundle({ schema_version: 1, sites: [secondSite()] }));
      expect(names(provider)).toEqual(['site_context', 'site_goto', 'site_list', 'site_read']);
    });

    it('lists the legal sites, pages and regions in the schema and description', () => {
      const b = bundle();
      const provider = makeProvider(container, writeBundle({ ...b, sites: [...b.sites, secondSite()] }));
      const read = tool(provider, 'site_read');
      expect(read.inputSchema.properties.site.enum).toEqual(['fixture', 'other-console']);
      expect(read.inputSchema.properties.page.enum).toEqual(
        expect.arrayContaining(['home', 'cluster-detail', 'alpha', 'beta', 'gamma']),
      );
      expect(read.inputSchema.required).toEqual(['site', 'page', 'region']);
      expect(read.description).toContain('home(title)');
      expect(read.description).toContain('alpha(rows_0, rows_1, heading)');
      const goto = tool(provider, 'site_goto');
      expect(goto.description).toContain('cluster-detail{cluster_id}');
    });

    it('names the legal sites when the site is unknown', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_read')!.execute({ site: 'nope', page: 'home', region: 'title' });
      expect(res.success).toBe(false);
      expect(res.error).toContain("unknown site 'nope'");
      expect(res.error).toContain('fixture');
    });

    it('names the legal pages when the page is unknown', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_goto')!.execute({ site: 'fixture', page: 'nowhere' });
      expect(res.success).toBe(false);
      expect(res.error).toContain("unknown page 'nowhere'");
      expect(res.error).toContain('home');
      expect(res.error).toContain('cluster-detail');
    });

    it('names the legal regions when the region is unknown', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_read')!.execute({ site: 'fixture', page: 'home', region: 'body' });
      expect(res.success).toBe(false);
      expect(res.error).toContain("unknown region 'body'");
      expect(res.error).toContain('title');
    });

    it('names the missing arguments instead of guessing', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_read')!.execute({ site: 'fixture' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('page');
    });

    it('reads a region on the matching console', async () => {
      const browser = fakeBrowser('https://console.example.invalid/clusters/69');
      const provider = makeProvider(container, writeBundle(bundle()), { chromeService: browser.service });
      const res = (await provider
        .getHandler('site_read')!
        .execute({ site: 'fixture', page: 'cluster_detail', region: 'pods' })) as any;
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({
        site: 'fixture',
        page: 'cluster-detail',
        region: 'pods',
        kind: 'read',
        result: { evaluated: 'READ_PODS' },
      });
    });

    it('accepts the slugged form of a site id', async () => {
      const b = bundle();
      const browser = fakeBrowser('https://other.example.invalid/beta');
      const provider = makeProvider(
        container,
        writeBundle({ ...b, sites: [...b.sites, secondSite()] }),
        { chromeService: browser.service },
      );
      const res = (await provider
        .getHandler('site_read')!
        .execute({ site: 'other_console', page: 'beta', region: 'heading' })) as any;
      expect(res.success).toBe(true);
      expect(res.data.result).toEqual({ evaluated: 'READ_beta_heading' });
    });

    it('refuses to read while the tab is on a different console', async () => {
      const browser = fakeBrowser('https://elsewhere.example.invalid/');
      const provider = makeProvider(container, writeBundle(bundle()), { chromeService: browser.service });
      const res = await provider.getHandler('site_read')!.execute({ site: 'fixture', page: 'home', region: 'title' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('elsewhere.example.invalid');
      expect(browser.sent.map((s) => s.params?.expression)).not.toContain(
        '(() => ({ status: "found", value: "hi" }))()',
      );
    });

    it('refuses a mutating control with no grant before touching the browser', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_act')!.execute({ site: 'fixture', page: 'home', control: 'delete' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/MUTATES the host/);
      expect(res.error).toMatch(/destroys everything/);
      expect(res.error).toMatch(/authorized_by/);
    });

    it('drives a mutating control under an explicit grant', async () => {
      const browser = fakeBrowser('https://console.example.invalid/home');
      const provider = makeProvider(container, writeBundle(bundle()), { chromeService: browser.service });
      const res = (await provider.getHandler('site_act')!.execute({
        site: 'fixture',
        page: 'home',
        control: 'delete',
        authorized_by: 'operator said: delete it',
      })) as any;
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({ control: 'delete', kind: 'act', result: { evaluated: '(() => true)()' } });
    });

    it('names the missing route parameters for a page that needs them', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_goto')!.execute({ site: 'fixture', page: 'cluster-detail' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('cluster_id');
    });

    it('navigates with Page.navigate to the resolved route, then waits for the page', async () => {
      const browser = fakeBrowser('https://console.example.invalid/home');
      const provider = makeProvider(container, writeBundle(bundle()), { chromeService: browser.service });
      const res = (await provider.getHandler('site_goto')!.execute({
        site: 'fixture',
        page: 'cluster-detail',
        params: { cluster_id: '69' },
      })) as any;
      expect(res.success).toBe(true);
      expect(browser.sent.find((s) => s.method === 'Page.navigate')?.params).toEqual({
        url: 'https://console.example.invalid/clusters/69',
      });
      expect(browser.sent.map((s) => s.params?.expression)).not.toContainEqual(
        expect.stringContaining('location.href ='),
      );
      expect(res.data).toMatchObject({
        site: 'fixture',
        page: 'cluster-detail',
        kind: 'goto',
        url: 'https://console.example.invalid/clusters/69',
        result: { evaluated: 'CLUSTER_READY' },
      });
    });

    it('names the sites that carry a suite when site_run_tests gets an unknown one', async () => {
      const provider = makeProvider(container, writeBundle(bundle()));
      const res = await provider.getHandler('site_run_tests')!.execute({ site: 'nope' });
      expect(res.success).toBe(false);
      expect(res.error).toContain("unknown site 'nope'");
      expect(res.error).toContain('fixture');
    });

    it('reports the active site and its pages through site_context', async () => {
      const browser = fakeBrowser('https://console.example.invalid/home');
      const provider = makeProvider(container, writeBundle(bundle()), { chromeService: browser.service });
      const res = (await provider.getHandler('site_context')!.execute({})) as any;
      expect(res.success).toBe(true);
      expect(res.data.active).toBe('fixture');
      expect(res.data.pages.map((p: any) => p.page)).toEqual(['home', 'cluster-detail']);
      expect(res.data.mutatingControls).toEqual([{ page: 'home', control: 'delete', describes: 'destroys everything' }]);
    });
  });
});
