import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Container } from '../../core/di/container.js';
import { createTestContainer, resetTestContainer } from '../test-container.js';
import { SiteToolProviderFactory, judgeCase, runAx } from '../../mcp/tools/providers/site-tools.factory.js';
import { ChromeServiceToken, LoggerToken, ValidatorToken } from '../../core/di/tokens.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const here = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_CASES = path.resolve(here, '../../../../crates/curupira-sites/fixtures/judge-cases.json');

const FAKE_AX = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_AX_LOG) fs.appendFileSync(process.env.FAKE_AX_LOG, JSON.stringify({ args, input: JSON.parse(input) }) + '\\n');
const out = (o, code = 0) => { process.stdout.write(JSON.stringify(o)); process.exit(code); };
if (process.env.FAKE_AX_SLEEP) { setTimeout(() => out({ outcome: 'read', status: 'found', value: 'late', matches: 1 }), 5000); return; }
if (process.env.FAKE_AX_GARBAGE) { process.stderr.write('panicked at seam.rs'); process.exit(101); }
if (process.env.FAKE_AX_UNTRUSTED) out({ outcome: 'not-trusted', grant: 'System Settings › Privacy & Security › Accessibility', responsible: { app: '/Applications/Mado.app' }, remedy: 'enable /Applications/Mado.app' }, 2);
const req = JSON.parse(input);
switch (args[0]) {
  case 'goto': out({ outcome: 'ready', ready: true, waitedMs: 0, unmet: [] });
  case 'read': out({ outcome: 'read', status: 'found', value: '0', truncated: false, matches: 1 });
  case 'act': {
    const i = args.indexOf('--authorized-by');
    if (req.op.action.effect === 'mutate' && i < 0) out({ outcome: 'refused', reason: 'no grant' }, 2);
    out({ outcome: 'acted', action: req.op.action.name, performed: req.op.action.perform || 'press', authorized_by: i < 0 ? undefined : args[i + 1] });
  }
  case 'run-tests': out({ outcome: 'tests', bundle_id: req.bundle_id, total: req.tests.length, passed: req.tests.length, failed: 0, cases: [] });
  default: out({ outcome: 'invalid-request', message: 'unknown verb ' + args[0] }, 64);
}
`;

function fakeAx(): { bin: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-ax-'));
  const bin = path.join(dir, 'curupira-ax');
  fs.writeFileSync(bin, `#!${process.execPath}\n${FAKE_AX}`, { mode: 0o755 });
  return { bin, log: path.join(dir, 'calls.jsonl') };
}

function calls(log: string): Array<{ args: string[]; input: any }> {
  return fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

function nativeSite() {
  const locator = { role: 'AXButton', description: { contains: 'clear' }, within: { role: 'AXWindow' } };
  return {
    id: 'example-calculator',
    target: 'macos-app',
    bundle_id: 'com.apple.calculator',
    tools: [
      {
        name: 'example_calculator_keypad_goto',
        description: 'Bring com.apple.calculator to the front',
        kind: 'goto',
        page: 'keypad',
        json_schema: { ...NO_ARGS, required: [] },
        ax: { op: 'ready', ready: [{ 'element-present': { role: 'AXButton' } }] },
      },
      {
        name: 'example_calculator_keypad_read_display',
        description: "Read 'display'",
        kind: 'read',
        page: 'keypad',
        json_schema: NO_ARGS,
        ax: { op: 'read', read: { name: 'display', locator: { role: 'AXStaticText' }, kind: 'text' }, limit: 20000 },
      },
      {
        name: 'example_calculator_keypad_act_clear',
        description: 'MUTATES the host: discards the current calculation',
        kind: 'act',
        page: 'keypad',
        json_schema: {
          type: 'object',
          properties: { authorized_by: { type: 'string', minLength: 1 } },
          required: ['authorized_by'],
          additionalProperties: false,
        },
        ax: { op: 'act', action: { name: 'clear', locator, effect: 'mutate', describes: 'discards the current calculation', perform: 'press' } },
        effect: 'mutate',
        describes: 'discards the current calculation',
      },
      {
        name: 'example_calculator_keypad_act_digit',
        description: "Press 'digit'",
        kind: 'act',
        page: 'keypad',
        json_schema: NO_ARGS,
        ax: { op: 'act', action: { name: 'digit', locator: { role: 'AXButton' }, effect: 'observe', perform: 'press' } },
        effect: 'observe',
        describes: '',
      },
    ],
    tests: [{ name: 'keypad renders', view: 'keypad', ready: [], read_checks: [] }],
  };
}

function browserSite() {
  return {
    id: 'fixture',
    target: 'browser',
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
        description: "Read 'title'",
        kind: 'read',
        page: 'home',
        json_schema: NO_ARGS,
        js: 'READ_TITLE',
      },
    ],
  };
}

function writeBundle(sites: unknown[], version = 2): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-sites-'));
  const p = path.join(dir, 'sites.bundle.json');
  fs.writeFileSync(p, JSON.stringify({ schema_version: version, sites }));
  return p;
}

function makeProvider(container: Container, bundlePath: string, chromeService?: unknown) {
  return new SiteToolProviderFactory().create({
    chromeService: chromeService ?? container.resolve(ChromeServiceToken),
    logger: container.resolve(LoggerToken),
    validator: container.resolve(ValidatorToken),
    siteBundlePath: bundlePath,
  } as any);
}

const exec = (provider: any, tool: string, args: Record<string, unknown>) => provider.getHandler(tool)!.execute(args) as Promise<any>;

describe('site tools on a macos-app target', () => {
  let container: Container;
  let ax: { bin: string; log: string };
  const saved = { ...process.env };

  beforeEach(() => {
    container = createTestContainer();
    ax = fakeAx();
    process.env.CURUPIRA_AX_BIN = ax.bin;
    process.env.FAKE_AX_LOG = ax.log;
  });
  afterEach(() => {
    resetTestContainer(container);
    for (const k of ['CURUPIRA_AX_BIN', 'CURUPIRA_AX_TIMEOUT_MS', 'FAKE_AX_LOG', 'FAKE_AX_SLEEP', 'FAKE_AX_UNTRUSTED', 'FAKE_AX_GARBAGE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reads through the curupira-ax process with the compiled op, and never through Chrome', async () => {
    const provider = makeProvider(container, writeBundle([nativeSite()]), { getCurrentClient: () => null });
    const res = await exec(provider, 'site_read', { site: 'example-calculator', page: 'keypad', region: 'display' });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      site: 'example-calculator',
      target: 'macos-app',
      bundleId: 'com.apple.calculator',
      page: 'keypad',
      region: 'display',
      result: { status: 'found', value: '0', matches: 1 },
    });
    const [call] = calls(ax.log);
    expect(call.args).toEqual(['read']);
    expect(call.input).toEqual({
      bundle_id: 'com.apple.calculator',
      op: { op: 'read', read: { name: 'display', locator: { role: 'AXStaticText' }, kind: 'text' }, limit: 20000 },
    });
  });

  it('refuses a mutating control with no authorized_by before spawning anything', async () => {
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_act', { site: 'example-calculator', page: 'keypad', control: 'clear' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/MUTATES the host/);
    expect(res.error).toMatch(/discards the current calculation/);
    expect(res.error).toMatch(/authorized_by/);
    expect(calls(ax.log)).toEqual([]);
  });

  it('passes the grant to curupira-ax as --authorized-by and reports what was pressed', async () => {
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_act', {
      site: 'example-calculator',
      page: 'keypad',
      control: 'clear',
      authorized_by: 'operator: clear it',
    });
    expect(res.success).toBe(true);
    expect(res.data.result).toEqual({ action: 'clear', performed: 'press', authorized_by: 'operator: clear it' });
    expect(calls(ax.log)[0].args).toEqual(['act', '--authorized-by', 'operator: clear it']);
  });

  it('drives an observe control with no grant flag', async () => {
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_act', { site: 'example-calculator', page: 'keypad', control: 'digit' });
    expect(res.success).toBe(true);
    expect(calls(ax.log)[0].args).toEqual(['act']);
  });

  it('goto brings the app forward and launches it only when asked', async () => {
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_goto', { site: 'example-calculator', page: 'keypad', launch: true });
    expect(res.success).toBe(true);
    expect(res.data.result).toEqual({ ready: true, waitedMs: 0, unmet: [] });
    const [call] = calls(ax.log);
    expect(call.args).toEqual(['goto']);
    expect(call.input.launch).toBe(true);
    expect(call.input.op.op).toBe('ready');
  });

  it('turns not-trusted into a failure that names the grant to make', async () => {
    process.env.FAKE_AX_UNTRUSTED = '1';
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_read', { site: 'example-calculator', page: 'keypad', region: 'display' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^not-trusted: /);
    expect(res.error).toContain('/Applications/Mado.app');
    expect(res.data.result.grant).toBe('System Settings › Privacy & Security › Accessibility');
  });

  it('runs the suite through curupira-ax run-tests with the compiled cases', async () => {
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_run_tests', { site: 'example-calculator' });
    expect(res.success).toBe(true);
    expect(res.data.result).toMatchObject({ bundle_id: 'com.apple.calculator', total: 1, failed: 0 });
    const [call] = calls(ax.log);
    expect(call.args).toEqual(['run-tests']);
    expect(call.input).toEqual({ bundle_id: 'com.apple.calculator', tests: nativeSite().tests, launch: false });
  });

  it('names CURUPIRA_AX_BIN when the binary is missing', async () => {
    process.env.CURUPIRA_AX_BIN = path.join(os.tmpdir(), 'definitely-not-curupira-ax');
    const provider = makeProvider(container, writeBundle([nativeSite()]));
    const res = await exec(provider, 'site_read', { site: 'example-calculator', page: 'keypad', region: 'display' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('CURUPIRA_AX_BIN');
  });

  it('kills a curupira-ax that outlives its timeout and says so', async () => {
    process.env.FAKE_AX_SLEEP = '1';
    const res = await runAx(['read'], { bundle_id: 'x.y', op: { op: 'read' } }, 300);
    expect(res).toEqual({ ok: false, error: 'curupira-ax read timed out after 300ms (CURUPIRA_AX_TIMEOUT_MS)' });
  });

  it('reports output that is not a typed outcome instead of guessing', async () => {
    process.env.FAKE_AX_GARBAGE = '1';
    const res = await runAx(['read'], {}, 5000);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('exited 101 without a typed outcome');
    expect((res as any).error).toContain('panicked at seam.rs');
  });

  it('lists native targets beside browser consoles, with their views', async () => {
    const provider = makeProvider(container, writeBundle([browserSite(), nativeSite()]));
    const res = await exec(provider, 'site_list', {});
    expect(res.data.sites[0]).toMatchObject({ id: 'fixture', target: 'browser', baseUrl: 'https://console.example.invalid' });
    expect(res.data.sites[1]).toMatchObject({ id: 'example-calculator', target: 'macos-app', bundleId: 'com.apple.calculator', mutating: 1, tests: 1 });
    expect(res.data.sites[1].pages[0]).toEqual({ page: 'keypad', regions: ['display'], controls: ['clear', 'digit'], params: [] });
    expect(res.data.sites[1].baseUrl).toBeUndefined();
  });

  it('site_context reports native targets even when Chrome is not connected', async () => {
    const provider = makeProvider(container, writeBundle([browserSite(), nativeSite()]), { getCurrentClient: () => null });
    const res = await exec(provider, 'site_context', {});
    expect(res.success).toBe(true);
    expect(res.data.browser.connected).toBe(false);
    expect(res.data.nativeTargets).toEqual([
      expect.objectContaining({
        id: 'example-calculator',
        bundleId: 'com.apple.calculator',
        mutatingControls: [{ page: 'keypad', control: 'clear', describes: 'discards the current calculation' }],
      }),
    ]);
  });

  it('never lets a native target claim a browser tab', async () => {
    const client = {
      send: async (_m: string, p: any) => ({ result: { value: p?.expression === 'window.location.href' ? 'https://console.example.invalid/home' : null } }),
    };
    const provider = makeProvider(container, writeBundle([nativeSite(), browserSite()]), { getCurrentClient: () => client });
    const res = await exec(provider, 'site_context', {});
    expect(res.data.matched).toEqual(['fixture']);
  });

  it('still loads a schema-1 bundle written before targets existed', async () => {
    const { target: _t, ...legacy } = browserSite();
    const provider = makeProvider(container, writeBundle([legacy], 1));
    const res = await exec(provider, 'site_list', {});
    expect(res.data.sites[0]).toMatchObject({ id: 'fixture', target: 'browser' });
  });
});

describe('the TS judge agrees with the Rust judge', () => {
  it('judges every shared fixture case exactly as curupira-sites testplan records it', () => {
    const cases = JSON.parse(fs.readFileSync(JUDGE_CASES, 'utf8')) as Array<{
      test: any;
      survey: Record<string, unknown>;
      reads: Array<Record<string, unknown>>;
      expect: unknown;
    }>;
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      expect(judgeCase(c.test, c.survey, c.reads), c.test.name).toEqual(c.expect);
    }
  });
});
