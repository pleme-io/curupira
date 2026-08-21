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
            name: 'fixture_home_read_title',
            description: "Read 'title' on the 'home' page",
            kind: 'read',
            page: 'home',
            json_schema: { type: 'object', properties: {}, additionalProperties: false },
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
        ],
      },
    ],
    ...overrides,
  };
}

function writeBundle(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-sites-'));
  const p = path.join(dir, 'sites.bundle.json');
  fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return p;
}

function makeProvider(container: Container, bundlePath: string) {
  return new SiteToolProviderFactory().create({
    chromeService: container.resolve(ChromeServiceToken),
    logger: container.resolve(LoggerToken),
    validator: container.resolve(ValidatorToken),
    siteBundlePath: bundlePath,
  } as any);
}

describe('SiteToolProvider', () => {
  let container: Container;

  beforeEach(() => {
    container = createTestContainer();
  });
  afterEach(() => {
    resetTestContainer(container);
  });

  it('registers the context tools plus every tool in the bundle', () => {
    const provider = makeProvider(container, writeBundle(bundle()));
    const names = provider.listTools().map((t: any) => t.name);
    expect(names).toContain('site_context');
    expect(names).toContain('site_list');
    expect(names).toContain('fixture_home_read_title');
    expect(names).toContain('fixture_home_act_delete');
  });

  it('always emits a real JSON Schema', () => {
    // Without one the base provider substitutes {additionalProperties:true},
    // which advertises that a tool accepts anything and turns what should be a
    // schema rejection into a runtime failure.
    const provider = makeProvider(container, writeBundle(bundle()));
    for (const t of provider.listTools()) {
      expect(t.inputSchema, `${t.name} has no inputSchema`).toBeDefined();
      expect((t.inputSchema as any).type).toBe('object');
    }
  });

  it('refuses a mutating tool with no grant, AT THE HANDLER', async () => {
    // The JSON Schema already marks authorized_by required, which stops a
    // well-behaved caller. This is the second line: it stops every caller,
    // including one that reaches the handler by another route. On borrowed
    // ground the cost of a missed check has no undo, so it is checked twice.
    const provider = makeProvider(container, writeBundle(bundle()));
    const res = await provider.getHandler('fixture_home_act_delete')!.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/MUTATES the host/);
    expect(res.error).toMatch(/authorized_by/);
  });

  it('names what the control does in the refusal', async () => {
    // Whoever is being asked to grant needs to know what they are approving.
    const provider = makeProvider(container, writeBundle(bundle()));
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
    expect(res.data.sites[0]).toMatchObject({ id: 'fixture', tools: 2, mutating: 1 });
  });
});
