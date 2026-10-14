/**
 * Site plugins: MCP tools generated from declarative console profiles.
 *
 * A profile describes a web console as data — its pages, the reads available on
 * them, and the controls they expose. `curupira-sites` compiles profiles into a
 * bundle of tool definitions with their JavaScript already baked in, and this
 * provider registers them. No Rust runs at request time; the bundle is a file.
 *
 * ── Why every tool is registered at startup ───────────────────────────────────
 *
 * Because the MCP client does not refresh its tool list after connecting (see
 * the note in `app.container.ts`). So "become aware of which console we are on"
 * cannot mean swapping tools when the tab changes. Instead every loaded site's
 * tools exist from the start, and `site_context` reports which profile matches
 * the active tab. Same behaviour for the caller; the only mechanism the client
 * supports.
 *
 * ── Borrowed ground ───────────────────────────────────────────────────────────
 *
 * A console usually belongs to someone else. Reads are in-bounds. A control the
 * profile classifies as mutating requires `authorized_by` — the operator's own
 * words, which cannot be defaulted because the generated JSON Schema marks it
 * required, and which travel with the call into the log rather than being
 * asserted afterwards.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type BaseToolProviderConfig } from '../base-tool-provider.js';
import { findChromeBinary, waitForCDP } from './chrome-launch-tools.factory.js';
import { ChromeIndependentToolProvider } from '../chrome-independent-tool-provider.js';
import { BaseProviderFactory, type ProviderDependencies } from '../provider.factory.js';
import type { ILogger } from '../../../core/interfaces/logger.interface.js';
import type { IChromeService } from '../../../core/interfaces/chrome-service.interface.js';
import type { IValidator } from '../../../core/interfaces/validator.interface.js';

/** One generated tool, as `curupira-sites` writes it. */
interface ToolSpec {
  name: string;
  description: string;
  kind: 'goto' | 'read' | 'act';
  page: string;
  json_schema: Record<string, unknown>;
  js?: string;
  ax?: AxOp;
  desktop?: DesktopOp;
  url_template?: string;
  tab?: string;
  effect?: 'observe' | 'mutate';
  describes?: string;
  input?: { submit: 'none' } | { submit: 'enter' } | { submit: 'click'; js: string };
}

interface CompiledEvent {
  page: string;
  name: string;
  install_js: string;
  drain_js: string;
}

interface AppLaunch {
  app: string;
  port: number;
}

// The compiled qualifying suite the Rust engine bakes into the bundle. The JUDGE
// (judgeCase below) mirrors curupira-sites' testplan::judge_case exactly — one
// verdict, two executors (this server, and curupira-e2e in Rust).
interface CompiledReadCheck {
  read: string;
  js: string;
  expect_status: string;
}
interface CompiledTest {
  name: string;
  route: string;
  tab?: string;
  survey_js: string;
  expect_controls?: string[];
  expect_routes?: string[];
  must_settle?: boolean;
  read_checks?: CompiledReadCheck[];
}

interface AxOp {
  op: 'ready' | 'read' | 'act';
  [field: string]: unknown;
}

type DesktopOp =
  | { op: 'ready'; ready: string[] }
  | { op: 'read'; region: string }
  | { op: 'act'; steps: string[]; params?: string[] };

type TargetKind = 'browser' | 'macos-app' | 'desktop';

type DesktopTier = 'read' | 'click' | 'full';

interface SiteBundle {
  id: string;
  target?: TargetKind;
  base_url?: string;
  match?: string[];
  bundle_id?: string;
  app?: string;
  tier?: DesktopTier;
  why?: string;
  promote?: string;
  tools: ToolSpec[];
  tests?: CompiledTest[];
  events?: CompiledEvent[];
  launch?: AppLaunch;
}

interface WorkspaceTab {
  key: string;
  url: string;
  site?: string;
  page?: string;
}

interface Workspace {
  name: string;
  description?: string;
  tabs: WorkspaceTab[];
}

interface Bundle {
  schema_version: number;
  sites: SiteBundle[];
  workspaces?: Workspace[];
  stack?: { layers: string[]; refused?: string[] };
}

function stackBin(): string {
  return process.env.CURUPIRA_STACK_BIN || 'curupira-stack';
}

const isNative = (site: SiteBundle): boolean => site.target === 'macos-app';
const isDesktop = (site: SiteBundle): boolean => site.target === 'desktop';
const claimsTabs = (site: SiteBundle): boolean => !isNative(site) && !isDesktop(site);

const DESKTOP_THEN = 'verify with screenshot that every ready text is visible';

export function substituteSteps(steps: string[], given: Record<string, unknown>): { ok: true; steps: string[] } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const out = steps.map((s) =>
    s.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
      const v = given[name];
      if (typeof v === 'string' && v !== '') return v;
      if (!missing.includes(name)) missing.push(name);
      return `{${name}}`;
    }),
  );
  return missing.length > 0 ? { ok: false, missing } : { ok: true, steps: out };
}

export type RouteDriver = 'curupira-cdp' | 'curupira-ax' | 'computer-use';

export interface RouteMatch {
  site: string;
  target: TargetKind;
  driver: RouteDriver;
  tools: string[];
  pages?: string[];
  views?: string[];
  promote?: string;
}

export interface RouteAnswer {
  query: string;
  matches: RouteMatch[];
  unmatched: boolean;
  next?: string;
}

export const ROUTE_NEXT =
  'map it: browser → curupira-sites draft <url>; native → curupira-ax survey <bundle_id>; else declare a desktop profile';

function hostOf(u: string | undefined): string {
  if (!u) return '';
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
}

export function routeQuery(bundle: Bundle, query: string): RouteAnswer {
  const q = query.trim().toLowerCase();
  const qHost = hostOf(q.includes('://') ? q : `https://${q}`) || q;
  const hit = (hay: string | undefined) => !!hay && hay.toLowerCase().includes(q);
  const scored: Array<{ score: number; m: RouteMatch }> = [];
  for (const s of q === '' ? [] : bundle.sites) {
    const target: TargetKind = s.target ?? 'browser';
    const names = [...new Set(s.tools.map((t) => t.page))];
    const hosts = [hostOf(s.base_url), ...(s.match ?? [])].filter((h) => h).map((h) => h.toLowerCase());
    const score =
      s.id.toLowerCase() === q || slug(s.id) === slug(q)
        ? 3
        : hosts.some((h) => h.includes(q) || (qHost !== '' && qHost.includes(h)))
          ? 2
          : hit(s.id) || hit(s.bundle_id) || hit(s.app) || names.some((n) => hit(n))
            ? 1
            : 0;
    if (score === 0) continue;
    const has = (k: ToolSpec['kind']) => s.tools.some((t) => t.kind === k);
    const verbs = [
      ...(has('goto') ? ['site_goto'] : []),
      ...(has('read') ? ['site_read'] : []),
      ...(has('act') ? ['site_act'] : []),
    ];
    const driver: RouteDriver = target === 'desktop' ? 'computer-use' : target === 'macos-app' ? 'curupira-ax' : 'curupira-cdp';
    const tools =
      driver === 'computer-use'
        ? [...verbs, 'mcp__computer-use__request_access', 'mcp__computer-use__open_application', 'mcp__computer-use__screenshot']
        : driver === 'curupira-ax'
          ? [...verbs, ...((s.tests ?? []).length > 0 ? ['site_run_tests'] : [])]
          : [...(s.launch ? ['site_app_launch'] : ['site_context']), ...verbs];
    scored.push({
      score,
      m: {
        site: s.id,
        target,
        driver,
        tools,
        ...(target === 'browser' ? { pages: names } : { views: names }),
        ...(s.promote ? { promote: s.promote } : {}),
      },
    });
  }
  scored.sort((a, b) => b.score - a.score || a.m.site.localeCompare(b.m.site));
  const matches = scored.map((x) => x.m);
  return { query, matches, unmatched: matches.length === 0, ...(matches.length === 0 ? { next: ROUTE_NEXT } : {}) };
}

type AxVerb = 'goto' | 'read' | 'act' | 'run-tests';

type AxRun = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const AX_DEFAULT_TIMEOUT_MS = 60_000;

function axBinary(): string {
  return process.env.CURUPIRA_AX_BIN || 'curupira-ax';
}

function axTimeoutMs(): number {
  const n = Number(process.env.CURUPIRA_AX_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : AX_DEFAULT_TIMEOUT_MS;
}

function parseOutcome(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw.trim()) as Record<string, unknown> | null;
    return v && typeof v.outcome === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function runAx(args: string[], input: unknown, timeoutMs: number = axTimeoutMs()): Promise<AxRun> {
  const bin = axBinary();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: AxRun) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `curupira-ax ${args[0]} timed out after ${timeoutMs}ms (CURUPIRA_AX_TIMEOUT_MS)` });
    }, timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        error:
          err.code === 'ENOENT'
            ? `curupira-ax not found at '${bin}': set CURUPIRA_AX_BIN or put curupira-ax on PATH`
            : `curupira-ax could not start: ${err.message}`,
      }),
    );
    child.on('close', (code) => {
      const value = parseOutcome(stdout);
      finish(
        value
          ? { ok: true, value }
          : {
              ok: false,
              error: `curupira-ax ${args[0]} exited ${code} without a typed outcome: ${(stderr || stdout).trim().slice(0, 500)}`,
            },
      );
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

const AX_SUCCESS = new Set(['ready', 'read', 'acted', 'tests', 'survey', 'trusted']);

export function axVerdict(value: Record<string, unknown>): { success: boolean; error?: string; result: Record<string, unknown> } {
  const { outcome, ...result } = value;
  const o = String(outcome);
  if (AX_SUCCESS.has(o)) return { success: true, result };
  const s = (k: string) => (typeof result[k] === 'string' ? (result[k] as string) : '');
  const error = (() => {
    switch (o) {
      case 'not-trusted':
        return `not trusted for Accessibility. ${s('remedy')}`;
      case 'app-not-running':
        return s('remedy') || `${s('bundle_id')} is not running`;
      case 'absent':
        return `control '${s('action')}' is not on screen (${s('locator')})`;
      case 'ambiguous':
        return `control '${s('action')}' matches ${String(result.matches)} elements (${s('locator')}); scope the locator with 'within' — nothing was pressed`;
      case 'refused':
        return `refused: ${s('reason')}`;
      default:
        return s('message') || s('reason') || `curupira-ax answered '${o}'`;
    }
  })();
  return { success: false, error: `${o}: ${error}`, result: { outcome: o, ...result } };
}

// ── The judge — a byte-for-byte port of curupira-sites::testplan ─────────────
// Kept identical to the Rust so a verdict is the same whichever executor ran it.

export function judgeSurvey(test: CompiledTest, survey: Record<string, unknown>): string[] {
  const fails: string[] = [];
  const controls = Array.isArray(survey.controls)
    ? (survey.controls as Array<Record<string, unknown>>).map((c) => String(c?.text ?? ''))
    : [];
  for (const want of test.expect_controls ?? []) {
    if (!controls.includes(want)) fails.push(`expected control '${want}' not present`);
  }
  const routes = Array.isArray(survey.routes) ? (survey.routes as unknown[]).map(String) : [];
  for (const want of test.expect_routes ?? []) {
    if (!routes.some((r) => r.includes(want))) fails.push(`expected route '${want}' not present`);
  }
  if (test.must_settle && survey.settled !== true) fails.push('page did not settle');
  return fails;
}

export function judgeRead(check: CompiledReadCheck, result: Record<string, unknown>): string | null {
  const got = typeof result.status === 'string' ? result.status : '<no status>';
  return got === check.expect_status
    ? null
    : `read '${check.read}': expected ${check.expect_status}, got ${got}`;
}

export function judgeCase(
  test: CompiledTest,
  survey: Record<string, unknown>,
  readResults: Array<Record<string, unknown>>,
): { name: string; passed: boolean; failures: string[] } {
  const failures = judgeSurvey(test, survey);
  const checks = test.read_checks ?? [];
  checks.slice(0, readResults.length).forEach((check, i) => {
    const f = judgeRead(check, readResults[i]);
    if (f) failures.push(f);
  });
  if (readResults.length !== checks.length) {
    failures.push(`executor ran ${readResults.length} read-checks, plan has ${checks.length}`);
  }
  return { name: test.name, passed: failures.length === 0, failures };
}

/** The bundle schema this provider understands. */
const SUPPORTED_SCHEMA = 2;
const READABLE_SCHEMAS = new Set([1, SUPPORTED_SCHEMA]);

/**
 * Where the bundle lives by default.
 *
 * Under the operator's config dir, NOT in this repository. A real profile
 * describes a third-party console's routes and menu structure, which is the
 * operator's business and not something a public repo should carry.
 */
function defaultBundlePath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'curupira', 'sites.bundle.json');
}

type LoadLogger = Pick<ILogger, 'debug' | 'info' | 'warn' | 'error'>;

export function readSiteStack(logger: LoadLogger): Bundle | null {
  const from = process.env.CURUPIRA_SITES_STACK_FROM || process.cwd();
  try {
    const out = execFileSync(stackBin(), ['build', '--from', from], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    const parsed = JSON.parse(out) as Bundle;
    if (!READABLE_SCHEMAS.has(parsed.schema_version) || (parsed.stack?.layers ?? []).length === 0) return null;
    for (const r of parsed.stack?.refused ?? []) logger.warn({ refused: r }, 'site stack entry refused');
    logger.info({ layers: parsed.stack?.layers }, 'site stack loaded');
    return parsed;
  } catch (err) {
    logger.debug({ err, bin: stackBin() }, 'no site stack; falling back to the static bundle');
    return null;
  }
}

export function readSiteBundleFile(p: string, logger: LoadLogger): Bundle | null {
  if (!fs.existsSync(p)) {
    logger.debug({ path: p }, 'no site bundle; site plugins inactive');
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Bundle;
    if (!READABLE_SCHEMAS.has(parsed.schema_version)) {
      logger.error(
        { path: p, found: parsed.schema_version, supported: [...READABLE_SCHEMAS] },
        'site bundle schema mismatch; refusing to load it rather than mis-read its fields',
      );
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error({ path: p, err }, 'site bundle unreadable; site plugins inactive');
    return null;
  }
}

export function loadSiteBundle(logger: LoadLogger): Bundle {
  const useStack = process.env.CURUPIRA_SITES_SOURCE !== 'bundle';
  return (
    (useStack ? readSiteStack(logger) : null) ??
    readSiteBundleFile(process.env.CURUPIRA_SITES_BUNDLE || defaultBundlePath(), logger) ?? {
      schema_version: SUPPORTED_SCHEMA,
      sites: [],
    }
  );
}

export interface SiteToolProviderConfig extends BaseToolProviderConfig {
  bundlePath: string;
  perPageTools: boolean;
  useStack?: boolean;
}

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

interface PageEntry {
  name: string;
  goto?: ToolSpec;
  reads: Map<string, ToolSpec>;
  controls: Map<string, ToolSpec>;
}

interface SiteEntry {
  site: SiteBundle;
  pages: Map<string, PageEntry>;
}

const PERMISSIVE = {
  parse: (v: unknown) => (v || {}) as Record<string, unknown>,
  safeParse: (v: unknown) => ({ success: true as const, data: (v || {}) as Record<string, unknown> }),
};

const NO_ARGS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

const NOT_CONNECTED = 'not connected to Chrome — run chrome_connect first (site tools drive an existing tab)';

function slug(s: string): string {
  let out = '';
  let lastUnderscore = false;
  for (const c of s) {
    if (/^[A-Za-z0-9]$/.test(c)) {
      out += c.toLowerCase();
      lastUnderscore = false;
    } else if (!lastUnderscore) {
      out += '_';
      lastUnderscore = true;
    }
  }
  return out.replace(/^_+|_+$/g, '');
}

function leafOf(site: SiteBundle, spec: ToolSpec): string {
  const prefix = `${slug(site.id)}_${slug(spec.page)}_${spec.kind}_`;
  return spec.name.startsWith(prefix) ? spec.name.slice(prefix.length) : slug(spec.name);
}

function routeParams(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{([^{}]+)\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function catalogue(site: SiteBundle): SiteEntry {
  const pages = new Map<string, PageEntry>();
  for (const spec of site.tools) {
    const key = slug(spec.page);
    const entry: PageEntry = pages.get(key) ?? { name: spec.page, reads: new Map(), controls: new Map() };
    pages.set(key, entry);
    if (spec.kind === 'goto') entry.goto = spec;
    else if (spec.kind === 'read') entry.reads.set(leafOf(site, spec), spec);
    else entry.controls.set(leafOf(site, spec), spec);
  }
  return { site, pages };
}

function pageSummary(page: PageEntry) {
  return {
    page: page.name,
    regions: [...page.reads.keys()],
    controls: [...page.controls.keys()],
    params: routeParams(page.goto?.url_template ?? ''),
  };
}

function legal(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function tabClickJs(tab: string): string {
  const label = JSON.stringify(tab);
  return `(()=>{const b=[...document.querySelectorAll('button,[role="tab"],a')].find(e=>((e).innerText||'').trim()===${label});if(b)(b).click();})()`;
}

/**
 * Extends the Chrome-INDEPENDENT provider deliberately.
 *
 * The default base resolves a Chrome session before it calls any handler, which
 * has two consequences this provider cannot accept. `site_list` answers purely
 * from a local file and would fail with "Not connected to Chrome" when the
 * browser is simply not running. And the borrowed-ground refusal would depend on
 * unrelated infrastructure being up — a gate that only works when the browser is
 * connected is not a gate. Both were found by test, 2026-08-21.
 *
 * The independent base validates args FIRST and passes a null client, so the
 * grant check runs before anything touches the browser, and tools that really
 * need CDP fetch the client themselves and say so plainly when it is absent.
 */
export class SiteToolProvider extends ChromeIndependentToolProvider<SiteToolProviderConfig> {
  // `declare`, not a field, and not `bundle!: Bundle` either.
  //
  // The base constructor calls initializeTools(), which loads the bundle. Under
  // useDefineForClassFields a subclass field DECLARATION still emits an
  // assignment in the constructor, running after super() returns — so the value
  // initializeTools just loaded is overwritten with undefined. The definite-
  // assignment `!` does not prevent that emit; it only silences the compiler.
  // `declare` emits nothing, so the load survives.
  //
  // Measured twice by test, 2026-08-21: first as "Cannot read properties of
  // undefined (reading 'sites')" from the field initialiser, then AGAIN with
  // `!` in place, which is what made the real cause visible.
  private declare bundle: Bundle;

  protected initializeTools(): void {
    this.bundle = { schema_version: SUPPORTED_SCHEMA, sites: [] };
    if (!this.loadStack()) this.loadBundle();
    this.entries = this.bundle.sites.map(catalogue);
    this.registerContextTools();
    this.registerGenericTools();
    this.registerWorkspaceTools();
    if (this.config.perPageTools) {
      for (const site of this.bundle.sites) {
        for (const spec of site.tools) {
          this.registerGeneratedTool(site, spec);
        }
        if (site.tests && site.tests.length > 0) {
          this.registerTestRunner(site);
        }
      }
    }
    this.logger.info(
      {
        sites: this.bundle.sites.length,
        tools: this.bundle.sites.reduce((n, s) => n + s.tools.length, 0),
        perPageTools: this.config.perPageTools,
      },
      'site plugins loaded',
    );
  }

  private declare entries: SiteEntry[];

  private resolveSite(arg: unknown, candidates: SiteEntry[] = this.entries): Resolved<SiteEntry> {
    const ids = candidates.map((e) => e.site.id);
    if (typeof arg !== 'string' || arg.trim() === '') {
      return { ok: false, error: `missing 'site'; legal sites: ${legal(ids)}` };
    }
    const hit = candidates.find((e) => slug(e.site.id) === slug(arg));
    return hit ? { ok: true, value: hit } : { ok: false, error: `unknown site '${arg}'; legal sites: ${legal(ids)}` };
  }

  private resolvePage(entry: SiteEntry, arg: unknown, has: (p: PageEntry) => boolean): Resolved<PageEntry> {
    const pages = [...entry.pages.values()].filter(has);
    const names = pages.map((p) => p.name);
    if (typeof arg !== 'string' || arg.trim() === '') {
      return { ok: false, error: `missing 'page'; legal pages on site '${entry.site.id}': ${legal(names)}` };
    }
    const hit = pages.find((p) => slug(p.name) === slug(arg));
    return hit
      ? { ok: true, value: hit }
      : { ok: false, error: `unknown page '${arg}' on site '${entry.site.id}'; legal pages: ${legal(names)}` };
  }

  private resolveLeaf(
    entry: SiteEntry,
    page: PageEntry,
    noun: 'region' | 'control',
    arg: unknown,
  ): Resolved<{ leaf: string; spec: ToolSpec }> {
    const table = noun === 'region' ? page.reads : page.controls;
    const keys = [...table.keys()];
    const where = `on page '${page.name}' of site '${entry.site.id}'`;
    if (typeof arg !== 'string' || arg.trim() === '') {
      return { ok: false, error: `missing '${noun}'; legal ${noun}s ${where}: ${legal(keys)}` };
    }
    const leaf = slug(arg);
    const spec = table.get(leaf);
    return spec
      ? { ok: true, value: { leaf, spec } }
      : { ok: false, error: `unknown ${noun} '${arg}' ${where}; legal ${noun}s: ${legal(keys)}` };
  }

  private describeCatalogue(render: (page: PageEntry) => string | null, sites: SiteEntry[] = this.entries): string {
    return sites
      .map((e) => {
        const pages = [...e.pages.values()].map(render).filter((x): x is string => x !== null);
        return pages.length > 0 ? `${e.site.id}: ${pages.join(', ')}` : null;
      })
      .filter((x): x is string => x !== null)
      .join('; ');
  }

  private siteSchema(sites: SiteEntry[]): Record<string, unknown> {
    return { type: 'string', enum: sites.map((e) => e.site.id), description: 'Site profile id' };
  }

  private pageSchema(has: (p: PageEntry) => boolean): Record<string, unknown> {
    const names = new Set<string>();
    for (const e of this.entries) for (const p of e.pages.values()) if (has(p)) names.add(p.name);
    return { type: 'string', enum: [...names], description: 'Page name on that site' };
  }

  private registerGenericTools(): void {
    const hasGoto = (p: PageEntry) => p.goto !== undefined;
    const hasReads = (p: PageEntry) => p.reads.size > 0;
    const hasControls = (p: PageEntry) => p.controls.size > 0;
    const sitesWith = (has: (p: PageEntry) => boolean) =>
      this.entries.filter((e) => [...e.pages.values()].some(has));

    const gotoSites = sitesWith(hasGoto);
    if (gotoSites.length > 0) {
      this.registerTool({
        name: 'site_goto',
        description:
          'Navigate the active tab to a page of a console profile (CDP Page.navigate), activate its tab if the ' +
          'profile names one, then wait until the page is ready. Pages with {params} need them in `params`. ' +
          'For a macos-app target, bring the app to the front and wait for the view\'s ready signals instead. ' +
          `Legal values — ${this.describeCatalogue((p) => {
            if (!p.goto) return null;
            const params = routeParams(p.goto.url_template ?? '');
            return params.length > 0 ? `${p.name}{${params.join(',')}}` : p.name;
          }, gotoSites)}`,
        argsSchema: PERMISSIVE,
        jsonSchema: {
          type: 'object',
          properties: {
            site: this.siteSchema(gotoSites),
            page: this.pageSchema(hasGoto),
            params: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Route parameters, keyed by the {name} in the page route',
            },
            launch: {
              type: 'boolean',
              description: 'macos-app targets only: start the app if it is not running',
            },
          },
          required: ['site', 'page'],
          additionalProperties: false,
        },
        handler: async (args: Record<string, unknown>) => this.gotoPage(args, gotoSites, hasGoto),
      });
    }

    const readSites = sitesWith(hasReads);
    if (readSites.length > 0) {
      this.registerTool({
        name: 'site_read',
        description:
          'Read a named region of a console page. The active tab must already be on that console ' +
          '(site_goto first); the result says found, empty or absent. ' +
          `Legal values — ${this.describeCatalogue(
            (p) => (p.reads.size > 0 ? `${p.name}(${[...p.reads.keys()].join(', ')})` : null),
            readSites,
          )}`,
        argsSchema: PERMISSIVE,
        jsonSchema: {
          type: 'object',
          properties: {
            site: this.siteSchema(readSites),
            page: this.pageSchema(hasReads),
            region: { type: 'string', description: 'Region name on that page' },
          },
          required: ['site', 'page', 'region'],
          additionalProperties: false,
        },
        handler: async (args: Record<string, unknown>) => this.driveLeaf('site_read', 'region', args, readSites, hasReads),
      });
    }

    const actSites = sitesWith(hasControls);
    if (actSites.length > 0) {
      this.registerTool({
        name: 'site_act',
        description:
          'Click a named control on a console page. A control marked MUTATES changes the host and is refused ' +
          "unless `authorized_by` carries the operator's explicit go-ahead for that action, in their words. " +
          `Legal values — ${this.describeCatalogue(
            (p) =>
              p.controls.size > 0
                ? `${p.name}(${[...p.controls.entries()]
                    .map(([leaf, spec]) =>
                      spec.effect === 'mutate' ? `${leaf} [MUTATES: ${spec.describes || 'changes state'}]` : leaf,
                    )
                    .join(', ')})`
                : null,
            actSites,
          )}`,
        argsSchema: PERMISSIVE,
        jsonSchema: {
          type: 'object',
          properties: {
            site: this.siteSchema(actSites),
            page: this.pageSchema(hasControls),
            control: { type: 'string', description: 'Control name on that page' },
            authorized_by: {
              type: 'string',
              description: "The operator's explicit go-ahead for THIS action, in their own words. Required for a MUTATES control.",
            },
            value: {
              type: 'string',
              description: 'Typing controls (and macos-app set-value controls): the text to type or set',
            },
            params: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'desktop targets only: values for the {name} placeholders in the action steps',
            },
          },
          required: ['site', 'page', 'control'],
          additionalProperties: false,
        },
        handler: async (args: Record<string, unknown>) => this.driveLeaf('site_act', 'control', args, actSites, hasControls),
      });
    }

    this.registerEventTools();
    this.registerLaunchTool();

    const testSites = this.entries.filter((e) => (e.site.tests ?? []).length > 0);
    if (testSites.length > 0) {
      this.registerTool({
        name: 'site_run_tests',
        description:
          "Run a console profile's qualifying test suite: for each case, navigate to the page, survey it, run its " +
          'read-checks, and report which expectations held. Read-only. Legal values — ' +
          testSites.map((e) => `${e.site.id} (${(e.site.tests ?? []).length} case(s))`).join(', '),
        argsSchema: PERMISSIVE,
        jsonSchema: {
          type: 'object',
          properties: {
            site: this.siteSchema(testSites),
            launch: {
              type: 'boolean',
              description: 'macos-app targets only: start the app if it is not running',
            },
          },
          required: ['site'],
          additionalProperties: false,
        },
        handler: async (args: Record<string, unknown>) => {
          const site = this.resolveSite(args.site, testSites);
          if (!site.ok) return { success: false, error: site.error };
          return this.runTests(site.value.site, args.launch === true);
        },
      });
    }
  }

  private async driveLeaf(
    tool: string,
    noun: 'region' | 'control',
    args: Record<string, unknown>,
    sites: SiteEntry[],
    has: (p: PageEntry) => boolean,
  ): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const site = this.resolveSite(args.site, sites);
    if (!site.ok) return { success: false, error: site.error };
    const page = this.resolvePage(site.value, args.page, has);
    if (!page.ok) return { success: false, error: page.error };
    const leaf = this.resolveLeaf(site.value, page.value, noun, args[noun]);
    if (!leaf.ok) return { success: false, error: leaf.error };
    return this.drive(site.value.site, leaf.value.spec, args, `${tool} ${page.value.name}/${leaf.value.leaf}`, {
      [noun]: leaf.value.leaf,
    });
  }

  private async gotoPage(
    args: Record<string, unknown>,
    sites: SiteEntry[],
    hasGoto: (p: PageEntry) => boolean,
  ): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const site = this.resolveSite(args.site, sites);
    if (!site.ok) return { success: false, error: site.error };
    const page = this.resolvePage(site.value, args.page, hasGoto);
    if (!page.ok) return { success: false, error: page.error };
    const goto = page.value.goto as ToolSpec;
    if (isDesktop(site.value.site)) return this.desktopPlan(site.value.site, goto, args, {});
    if (isNative(site.value.site)) {
      return this.axDrive(site.value.site, goto, 'goto', { launch: args.launch === true }, [], {});
    }
    const template = goto.url_template;
    if (!template) {
      return { success: false, error: `page '${page.value.name}' of site '${site.value.site.id}' has no route to navigate to` };
    }
    const required = routeParams(template);
    const given = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {};
    const missing = required.filter((p) => typeof given[p] !== 'string' || (given[p] as string) === '');
    if (missing.length > 0) {
      return {
        success: false,
        error:
          `page '${page.value.name}' of site '${site.value.site.id}' needs route params: ${missing.join(', ')}; ` +
          `pass params: {${required.map((p) => `"${p}": "..."`).join(', ')}}`,
      };
    }
    const url = required.reduce((u, p) => u.split(`{${p}}`).join(encodeURIComponent(String(given[p]))), template);
    const nav = await this.navigate(url, goto.tab);
    if (!nav.ok) return { success: false, error: nav.error };
    const ready = await this.evaluate(goto.js ?? '');
    if (!ready.ok) return { success: false, error: ready.error };
    return {
      success: true,
      data: {
        site: site.value.site.id,
        page: page.value.name,
        kind: 'goto',
        url,
        ...(goto.tab ? { tab: goto.tab } : {}),
        result: ready.value ?? null,
      },
    };
  }

  private async navigate(url: string, tab?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const client = this.chromeService.getCurrentClient();
    if (!client) return { ok: false, error: NOT_CONNECTED };
    try {
      await client.send('Page.navigate', { url });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const target = new URL(url);
    await this.waitForUrl(`${target.pathname}${target.search}`, 8000);
    if (tab) await this.evaluate(tabClickJs(tab));
    return { ok: true };
  }

  /**
   * Read the bundle. A missing file is NORMAL — most installs have no profiles —
   * so it yields an empty bundle rather than an error. A malformed or
   * wrong-version file is not normal and is reported, because silently
   * registering nothing would look identical to having no profiles.
   */
  private loadStack(): boolean {
    if (!this.config.useStack) return false;
    const parsed = readSiteStack(this.logger);
    if (!parsed) return false;
    this.bundle = parsed;
    return true;
  }

  private registerWorkspaceTools(): void {
    const workspaces = this.bundle.workspaces ?? [];
    if (workspaces.length === 0 && !this.bundle.stack) return;
    this.registerTool({
      name: 'site_workspace_list',
      description:
        'List the site workspaces (named tab sets, e.g. an incident or start-of-day set) merged from the ' +
        'system, user and repo stack layers, with the URL each tab opens, the layers used and any refused entries.',
      argsSchema: PERMISSIVE,
      jsonSchema: NO_ARGS_SCHEMA,
      handler: async () => ({
        success: true,
        data: {
          workspaces,
          layers: this.bundle.stack?.layers ?? [],
          refused: this.bundle.stack?.refused ?? [],
        },
      }),
    });
    this.registerPostureTools();
    if (workspaces.length === 0) return;
    this.registerTool({
      name: 'site_workspace_open',
      description:
        'Bring up every tab of a site workspace in a visible Chrome, one tab per entry: the connected Chrome if any, ' +
        'else the Chrome on the DevTools port, else a newly launched headed Chrome with a persistent profile (SSO logins stick), so the ' +
        'operator can watch them while site_read / site_goto drive them. Optional `only` limits it to some tab keys. ' +
        `Legal workspaces: ${legal(workspaces.map((w) => w.name))}.`,
      argsSchema: PERMISSIVE,
      jsonSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', enum: workspaces.map((w) => w.name) },
          only: { type: 'array', items: { type: 'string' } },
        },
        required: ['workspace'],
      },
      handler: async (args: Record<string, unknown>) => this.openWorkspace(args, workspaces),
    });
  }

  private registerPostureTools(): void {
    const postures = (this.bundle as { postures?: Array<{ name: string }> }).postures ?? [];
    if (postures.length === 0) return;
    const port = Number(process.env.CURUPIRA_WORKSPACE_CHROME_PORT || '9222');
    this.registerTool({
      name: 'site_posture',
      description:
        'Show or set the operating posture. The posture is an eventual state curupira converges while it runs: its workspace tabs ' +
        'kept open (enforce) or reported (observe), and tabs outside it questioned, closed or ignored. Returns the last reconcile ' +
        `report and the open strays. Legal: ${legal(['off', ...postures.map((p) => p.name)])}.`,
      argsSchema: PERMISSIVE,
      jsonSchema: { type: 'object', properties: { name: { type: 'string', enum: ['off', ...postures.map((p) => p.name)] } } },
      handler: async (args: Record<string, unknown>) => {
        const { currentPosture, setPosture } = await import('../../../warm/warm.js');
        const { lastReport, readStrays, reconcileOnce } = await import('../../../reconcile/reconcile.js');
        if (typeof args.name === 'string') {
          setPosture(args.name);
          await reconcileOnce({ port });
        }
        return { success: true, data: { posture: currentPosture(), last: lastReport(), strays: readStrays() } };
      },
    });
    this.registerTool({
      name: 'site_posture_stray',
      description:
        'Resolve a tab open outside the posture (keyed by host, from site_posture strays): adopt stops asking about it, dismiss keeps ' +
        'it quiet while open, close closes its tabs (effect: mutate, needs authorized_by naming who said so).',
      argsSchema: PERMISSIVE,
      jsonSchema: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          action: { type: 'string', enum: ['adopt', 'dismiss', 'close'] },
          authorized_by: { type: 'string' },
        },
        required: ['host', 'action'],
      },
      handler: async (args: Record<string, unknown>) => {
        const action = args.action as 'adopt' | 'dismiss' | 'close';
        if (action === 'close' && !(typeof args.authorized_by === 'string' && args.authorized_by.trim())) {
          return { success: false, error: 'close is effect: mutate; pass authorized_by naming who said so' };
        }
        const { resolveStray } = await import('../../../reconcile/reconcile.js');
        try {
          return { success: true, data: await resolveStray(String(args.host), action, port) };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  private async openWorkspace(
    args: Record<string, unknown>,
    workspaces: Workspace[],
  ): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const ws = workspaces.find((w) => w.name === args.workspace);
    if (!ws) {
      return { success: false, error: `unknown workspace '${String(args.workspace)}'; legal: ${legal(workspaces.map((w) => w.name))}` };
    }
    const only = Array.isArray(args.only) ? new Set(args.only.map(String)) : null;
    const tabs = ws.tabs.filter((t) => !only || only.has(t.key));
    const client = this.chromeService.getCurrentClient();
    if (!client) return this.openWithoutConnection(ws.name, tabs);
    const opened: Array<{ key: string; url: string; targetId: string }> = [];
    const failed: Array<{ key: string; url: string; error: string }> = [];
    for (const t of tabs) {
      try {
        const res = (await client.send('Target.createTarget', { url: t.url })) as { targetId?: string };
        opened.push({ key: t.key, url: t.url, targetId: res?.targetId ?? '' });
      } catch (err) {
        failed.push({ key: t.key, url: t.url, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { success: failed.length === 0, data: { workspace: ws.name, opened, failed } };
  }

  private async openWithoutConnection(
    workspace: string,
    tabs: WorkspaceTab[],
  ): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const port = Number(process.env.CURUPIRA_WORKSPACE_CHROME_PORT || 9222);
    const base = `http://127.0.0.1:${port}`;
    const running = await fetch(`${base}/json/version`).then((r) => r.ok).catch(() => false);
    if (!running) {
      const bin = process.env.CURUPIRA_WORKSPACE_CHROME_BIN || findChromeBinary();
      if (!bin) return { success: false, error: 'not connected to Chrome and no Chrome binary found to launch' };
      const profile =
        process.env.CURUPIRA_WORKSPACE_CHROME_PROFILE || path.join(os.homedir(), '.config', 'curupira', 'chrome-workspace');
      const child = spawn(
        bin,
        [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', ...tabs.map((t) => t.url)],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      const up = await waitForCDP('127.0.0.1', port, 30000);
      return {
        success: up,
        ...(up ? {} : { error: `launched ${bin} but its DevTools port ${port} never answered` }),
        data: { workspace, launched: { bin, port, profile }, opened: tabs.map((t) => ({ key: t.key, url: t.url })), failed: [], next: 'chrome_connect to drive these tabs with site_read / site_goto' },
      };
    }
    const opened: Array<{ key: string; url: string; targetId: string }> = [];
    const failed: Array<{ key: string; url: string; error: string }> = [];
    for (const t of tabs) {
      try {
        const r = await fetch(`${base}/json/new?${encodeURI(t.url)}`, { method: 'PUT' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { id?: string };
        opened.push({ key: t.key, url: t.url, targetId: j.id ?? '' });
      } catch (err) {
        failed.push({ key: t.key, url: t.url, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { success: failed.length === 0, data: { workspace, opened, failed } };
  }

  private loadBundle(): void {
    const parsed = readSiteBundleFile(this.config.bundlePath, this.logger);
    if (parsed) this.bundle = parsed;
  }

  /**
   * Evaluate an expression in the active page.
   *
   * Returns a typed failure when Chrome is not connected rather than throwing,
   * so "the browser is not running" stays distinguishable from "the console
   * returned nothing" — which is the same found/empty/absent discipline the
   * generated reads use inside the page.
   */

  /**
   * Register `<site>_run_tests` — run the site's compiled qualifying suite against
   * the live site and report a per-case verdict. Read-only: it navigates,
   * surveys, and reads, exactly what the mapper is limited to.
   *
   * The gathering (navigate + eval) is this server's job; the JUDGING calls the
   * same logic curupira-sites/testplan uses, ported below, so a verdict here and
   * in curupira-e2e (Rust) is identical.
   */
  private registerTestRunner(site: SiteBundle): void {
    this.registerTool({
      name: `${site.id.replace(/[^a-z0-9]+/gi, '_')}_run_tests`,
      description:
        `Run the qualifying test suite for the '${site.id}' console: for each case, navigate to the page, ` +
        `survey it, run its read-checks, and report which expectations held. Read-only. ` +
        `${(site.tests ?? []).length} case(s) on hand.`,
      argsSchema: PERMISSIVE,
      jsonSchema: NO_ARGS_SCHEMA,
      handler: async () => this.runTests(site),
    });
  }

  private async axDrive(
    site: SiteBundle,
    spec: ToolSpec,
    verb: AxVerb,
    input: Record<string, unknown>,
    flags: string[],
    extra: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string; data?: unknown }> {
    if (!site.bundle_id) {
      return { success: false, error: `site '${site.id}' is a macos-app target with no bundle_id in the bundle` };
    }
    const payload = verb === 'run-tests' ? { bundle_id: site.bundle_id, ...input } : { bundle_id: site.bundle_id, op: spec.ax, ...input };
    const run = await runAx([verb, ...flags], payload);
    if (!run.ok) return { success: false, error: run.error };
    const verdict = axVerdict(run.value);
    const data = {
      site: site.id,
      target: 'macos-app',
      bundleId: site.bundle_id,
      ...(verb === 'run-tests' ? {} : { page: spec.page, kind: spec.kind }),
      ...extra,
      result: verdict.result,
    };
    return verdict.success ? { success: true, data } : { success: false, error: verdict.error, data };
  }

  private async runTests(site: SiteBundle, launch = false): Promise<{ success: boolean; error?: string; data?: unknown }> {
    if (isNative(site)) {
      return this.axDrive(site, { name: `${site.id}_run_tests`, description: '', kind: 'goto', page: '', json_schema: {} }, 'run-tests', { tests: site.tests ?? [], launch }, [], {});
    }
    const cases: Array<{ name: string; passed: boolean; failures: string[] }> = [];
    for (const t of site.tests ?? []) {
      const nav = await this.navigate((site.base_url ?? '').replace(/\/+$/, '') + t.route, t.tab);
      if (!nav.ok) return { success: false, error: nav.error };
      const surveyRes = await this.evaluate(t.survey_js);
      const survey = surveyRes.ok ? (surveyRes.value as Record<string, unknown>) : {};
      const readResults: Array<Record<string, unknown>> = [];
      for (const c of t.read_checks ?? []) {
        const r = await this.evaluate(c.js);
        readResults.push(r.ok ? (r.value as Record<string, unknown>) : { status: '<eval-error>' });
      }
      cases.push(judgeCase(t, survey, readResults));
    }
    const passed = cases.filter((c) => c.passed).length;
    return {
      success: true,
      data: { site: site.id, total: cases.length, passed, failed: cases.length - passed, cases },
    };
  }

  /**
   * Wait until the tab has navigated to `route` AND the document has finished
   * loading, then a short render beat.
   *
   * The beat is load-bearing, learned running a suite against a live SPA: the
   * settle-aware survey can settle on the INITIAL blank document (it is quiet
   * because the app has not started rendering yet), reporting an empty page as
   * settled. Waiting for `readyState==='complete'` plus a beat lets the app mount
   * before the survey looks, so "settled" means "rendered", not "not yet started".
   */
  private async waitForUrl(route: string, timeoutMs: number): Promise<void> {
    // Match on the path portion, ignoring a query string, so a route like
    // `/?auth-type=email` is not compared against a URL that has not gained the
    // query yet — but a bare `/` (which every URL includes) never short-circuits.
    const path = route.split('?')[0];
    const needle = path && path !== '/' ? path : route;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const res = await this.evaluate('[window.location.href, document.readyState].join("||")');
      if (res.ok) {
        const [href, state] = String(res.value ?? '').split('||');
        if (href.includes(needle) && state === 'complete') break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // Render beat so the survey sees the mounted app, not the empty shell.
    await new Promise((r) => setTimeout(r, 1200));
  }

  private async evaluate(expression: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const client = this.chromeService.getCurrentClient();
    if (!client) {
      return { ok: false, error: NOT_CONNECTED };
    }
    try {
      const res = await client.send<any>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res?.exceptionDetails) {
        return { ok: false, error: `page threw: ${res.exceptionDetails?.text ?? 'unknown'}` };
      }
      return { ok: true, value: res?.result?.value ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private resolveStream(args: Record<string, unknown>, needName: boolean): Resolved<{ site: SiteBundle; streams: CompiledEvent[] }> {
    const watchable = this.entries.filter((e) => (e.site.events ?? []).length > 0);
    const s = this.resolveSite(args?.site, watchable);
    if (!s.ok) return s;
    const all = s.value.site.events ?? [];
    const want = typeof args?.stream === 'string' ? args.stream : '';
    if (!want) {
      return needName
        ? { ok: false, error: `missing 'stream'; legal streams on '${s.value.site.id}': ${legal(all.map((e) => e.name))}` }
        : { ok: true, value: { site: s.value.site, streams: all } };
    }
    const hit = all.filter((e) => slug(e.name) === slug(want));
    return hit.length
      ? { ok: true, value: { site: s.value.site, streams: hit } }
      : { ok: false, error: `unknown stream '${want}' on '${s.value.site.id}'; legal streams: ${legal(all.map((e) => e.name))}` };
  }

  private async onSiteTab(site: SiteBundle): Promise<{ ok: true } | { ok: false; error: string }> {
    const url = await this.evaluate('window.location.href');
    if (!url.ok) return url;
    return (site.match ?? []).some((m) => m && String(url.value ?? '').includes(m))
      ? { ok: true }
      : { ok: false, error: `the active tab is ${String(url.value)}, not '${site.id}'; site_goto there first` };
  }

  private registerEventTools(): void {
    const watchable = this.entries.filter((e) => (e.site.events ?? []).length > 0);
    if (watchable.length === 0) return;
    const catalogue = watchable
      .map((e) => `${e.site.id}(${(e.site.events ?? []).map((v) => `${v.name}@${v.page}`).join(', ')})`)
      .join('; ');
    const schema = (required: string[]) => ({
      type: 'object',
      properties: {
        site: this.siteSchema(watchable),
        stream: { type: 'string', description: 'Event stream name on that site' },
      },
      required,
      additionalProperties: false,
    });
    this.registerTool({
      name: 'site_watch',
      description:
        'Start watching a page event stream (new messages, new alerts, new rows) on the active tab. Read-only. ' +
        `Idempotent; re-run after the page navigates. Legal values — ${catalogue}`,
      argsSchema: PERMISSIVE,
      jsonSchema: schema(['site', 'stream']),
      handler: async (args: Record<string, unknown>) => {
        const r = this.resolveStream(args, true);
        if (!r.ok) return { success: false, error: r.error };
        const on = await this.onSiteTab(r.value.site);
        if (!on.ok) return { success: false, error: on.error };
        const res = await this.evaluate(r.value.streams[0]!.install_js);
        if (!res.ok) return { success: false, error: res.error };
        const v = res.value as { installed?: boolean; within?: boolean } | null;
        if (!v?.installed) {
          return { success: false, error: `stream '${r.value.streams[0]!.name}': its container is not on this page (wrong page or not rendered yet)` };
        }
        return { success: true, data: { site: r.value.site.id, stream: r.value.streams[0]!.name, ...v } };
      },
    });
    this.registerTool({
      name: 'site_events',
      description:
        'Drain buffered events from watched streams on the active tab (all of a site\'s streams when `stream` is omitted). ' +
        '`watching: false` means no observer is installed there, which is NOT the same as no events: call site_watch. ' +
        `Legal values — ${catalogue}`,
      argsSchema: PERMISSIVE,
      jsonSchema: schema(['site']),
      handler: async (args: Record<string, unknown>) => {
        const r = this.resolveStream(args, false);
        if (!r.ok) return { success: false, error: r.error };
        const on = await this.onSiteTab(r.value.site);
        if (!on.ok) return { success: false, error: on.error };
        const out: Record<string, unknown> = {};
        for (const s of r.value.streams) {
          const res = await this.evaluate(s.drain_js);
          out[s.name] = res.ok ? res.value : { error: res.error };
        }
        return { success: true, data: { site: r.value.site.id, streams: out } };
      },
    });
  }

  private registerLaunchTool(): void {
    const apps = this.entries.filter((e) => e.site.launch);
    if (apps.length === 0) return;
    this.registerTool({
      name: 'site_app_launch',
      description:
        'Launch an Electron desktop app (one Chromium the site profile names) with a DevTools port and connect curupira to it, ' +
        'so site_goto / site_read / site_act / site_watch drive the app like a web tab. If the app is already running without ' +
        'the port, it must be quit first. Legal values — ' +
        apps.map((e) => `${e.site.id} (${e.site.launch!.app}, port ${e.site.launch!.port})`).join(', '),
      argsSchema: PERMISSIVE,
      jsonSchema: {
        type: 'object',
        properties: { site: this.siteSchema(apps) },
        required: ['site'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>) => {
        const s = this.resolveSite(args?.site, apps);
        if (!s.ok) return { success: false, error: s.error };
        const { app, port } = s.value.site.launch!;
        let up = await waitForCDP('localhost', port, 1000);
        if (!up) {
          const child = spawn('open', ['-na', app, '--args', `--remote-debugging-port=${port}`], { stdio: 'ignore', detached: true });
          child.unref();
          up = await waitForCDP('localhost', port, 30000);
        }
        if (!up) {
          return {
            success: false,
            error: `${app} did not open DevTools on port ${port}. If it was already running, quit it fully and retry; ` +
              'if it still refuses, this build disables remote debugging and the site must use its web URL instead.',
          };
        }
        await this.chromeService.connect({ host: 'localhost', port });
        return { success: true, data: { site: s.value.site.id, app, port, connected: true } };
      },
    });
  }

  private async typeInto(spec: ToolSpec, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    const text = typeof args?.value === 'string' ? args.value : '';
    if (!text) return { ok: false, error: `'${spec.name}' types text: pass a non-empty 'value'` };
    const client = this.chromeService.getCurrentClient();
    if (!client) return { ok: false, error: NOT_CONNECTED };
    const focused = await this.evaluate(spec.js ?? '');
    if (!focused.ok) return focused;
    if (focused.value !== true) return { ok: false, error: `'${spec.name}': the text box is not on the page (focus failed)` };
    try {
      await client.send('Input.insertText', { text });
      const submit = spec.input!;
      if (submit.submit === 'enter') {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      } else if (submit.submit === 'click') {
        const clicked = await this.evaluate(submit.js);
        if (!clicked.ok) return clicked;
        if (clicked.value !== true) return { ok: false, error: `'${spec.name}': typed, but the send control is not on the page` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Which site claims a URL. First match wins; ambiguity is reported, not resolved. */
  private sitesForUrl(url: string): SiteBundle[] {
    return this.bundle.sites.filter((s) => claimsTabs(s) && (s.match ?? []).some((m) => m && url.includes(m)));
  }

  private desktopPlan(
    site: SiteBundle,
    spec: ToolSpec,
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ): { success: boolean; error?: string; data?: unknown } {
    const op = spec.desktop;
    if (!op || !site.app) {
      return { success: false, error: `site '${site.id}' is a desktop target with no app or plan in the bundle` };
    }
    const viewReady = site.tools.find((t) => t.kind === 'goto' && t.page === spec.page)?.desktop;
    const ready = viewReady && viewReady.op === 'ready' ? viewReady.ready : [];
    let steps: string[];
    if (op.op === 'ready') {
      steps = [`open ${site.app}`, 'screenshot'];
    } else if (op.op === 'read') {
      steps = ['screenshot'];
    } else {
      const given = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {};
      const sub = substituteSteps(op.steps, given);
      if (!sub.ok) {
        return {
          success: false,
          error:
            `'${site.id}' ${spec.page}/${spec.name} needs params: ${sub.missing.join(', ')}; ` +
            `pass params: {${(op.params ?? sub.missing).map((p) => `"${p}": "..."`).join(', ')}}`,
        };
      }
      steps = sub.steps;
    }
    return {
      success: true,
      data: {
        driver: 'computer-use',
        site: site.id,
        app: site.app,
        ...(site.bundle_id ? { bundleId: site.bundle_id } : {}),
        tier: site.tier ?? 'full',
        view: spec.page,
        kind: spec.kind,
        ...extra,
        ...(op.op === 'read' ? { region: op.region } : {}),
        ready,
        steps,
        then: DESKTOP_THEN,
      },
    };
  }

  private registerContextTools(): void {
    this.registerTool({
      name: 'site_context',
      description:
        'Report which console profile matches the active browser tab, and what that profile exposes. This is how curupira knows which site it is looking at.',
      argsSchema: PERMISSIVE,
      jsonSchema: NO_ARGS_SCHEMA,
      handler: async () => {
        const res = await this.evaluate('window.location.href');
        const nativeTargets = this.entries
          .filter((e) => !claimsTabs(e.site))
          .map((e) => ({
            id: e.site.id,
            target: e.site.target,
            bundleId: e.site.bundle_id ?? null,
            ...(isDesktop(e.site) ? { app: e.site.app, tier: e.site.tier, driver: 'computer-use' } : {}),
            views: [...e.pages.values()].map(pageSummary),
            mutatingControls: [...e.pages.values()].flatMap((p) =>
              [...p.controls.entries()]
                .filter(([, spec]) => spec.effect === 'mutate')
                .map(([control, spec]) => ({ page: p.name, control, describes: spec.describes ?? '' })),
            ),
          }));
        if (!res.ok) {
          if (nativeTargets.length === 0) return { success: false, error: res.error };
          return {
            success: true,
            data: {
              url: null,
              browser: { connected: false, error: res.error },
              matched: [],
              ambiguous: false,
              active: null,
              pages: [],
              mutatingControls: [],
              nativeTargets,
              loadedSites: this.bundle.sites.map((s) => s.id),
            },
          };
        }
        const url = String(res.value ?? '');
        const matches = this.sitesForUrl(url);
        const active = matches[0] ? this.entries.find((e) => e.site === matches[0]) : undefined;
        const pages = active ? [...active.pages.values()] : [];

        return {
          success: true,
          data: {
            url,
            matched: matches.map((s) => s.id),
            // Ambiguity is surfaced rather than resolved to a winner: two
            // profiles claiming one URL is an authoring mistake, and picking a
            // "best" one would hide it behind plausible behaviour.
            ambiguous: matches.length > 1,
            active: matches[0]?.id ?? null,
            pages: pages.map(pageSummary),
            mutatingControls: pages.flatMap((p) =>
              [...p.controls.entries()]
                .filter(([, spec]) => spec.effect === 'mutate')
                .map(([control, spec]) => ({ page: p.name, control, describes: spec.describes ?? '' })),
            ),
            ...(this.config.perPageTools
              ? {
                  tools: matches[0]?.tools.map((t) => t.name) ?? [],
                  mutatingTools: matches[0]?.tools.filter((t) => t.effect === 'mutate').map((t) => t.name) ?? [],
                }
              : {}),
            ...(nativeTargets.length > 0 ? { nativeTargets } : {}),
            loadedSites: this.bundle.sites.map((s) => s.id),
          },
        };
      },
    });

    this.registerTool({
      name: 'site_route',
      description:
        'Route a query (a site id, URL or host, app name, bundle id, or page/view name) to the profile that drives it ' +
        'and the driver behind it: curupira-cdp (browser), curupira-ax (macos-app) or computer-use (desktop). ' +
        'Answers the exact tools to call next; an unmatched query answers how to map it.',
      argsSchema: PERMISSIVE,
      jsonSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, description: 'What to route' } },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>) => {
        if (typeof args.query !== 'string' || args.query.trim() === '') {
          return { success: false, error: "missing 'query'" };
        }
        return { success: true, data: routeQuery(this.bundle, args.query) };
      },
    });

    this.registerTool({
      name: 'site_list',
      description:
        'List every loaded profile — browser consoles and macos-app targets — with its pages (views), readable regions, controls and route params.',
      argsSchema: PERMISSIVE,
      jsonSchema: NO_ARGS_SCHEMA,
      handler: async () => ({
        success: true,
        data: {
          sites: this.entries.map(({ site: s, pages }) => ({
            id: s.id,
            target: s.target ?? 'browser',
            ...(isDesktop(s)
              ? { app: s.app, ...(s.bundle_id ? { bundleId: s.bundle_id } : {}), tier: s.tier, why: s.why, ...(s.promote ? { promote: s.promote } : {}) }
              : isNative(s)
                ? { bundleId: s.bundle_id }
                : { baseUrl: s.base_url, match: s.match ?? [] }),
            tools: s.tools.length,
            mutating: s.tools.filter((t) => t.effect === 'mutate').length,
            pages: [...pages.values()].map(pageSummary),
            tests: (s.tests ?? []).length,
          })),
        },
      }),
    });
  }

  private registerGeneratedTool(site: SiteBundle, spec: ToolSpec): void {
    this.registerTool({
      name: spec.name,
      description: spec.description,
      // Permissive by design. The host's validator replaces a schema error with
      // a generic "Validation failed for <tool>", which discards the sentence
      // that tells the operator WHAT they are being asked to authorise — and
      // that sentence is the entire point of the gate. Measured by test,
      // 2026-08-21.
      //
      // Refusing in the handler keeps the message intact, and it still happens
      // before anything touches the browser: this provider extends the
      // Chrome-INDEPENDENT base, so no session is established on the way in.
      argsSchema: PERMISSIVE,
      // Always present. Without it the base provider substitutes
      // {additionalProperties:true}, which advertises that the tool accepts
      // anything and turns a schema rejection into a runtime failure.
      jsonSchema: spec.json_schema,
      handler: async (args: Record<string, unknown>) => this.drive(site, spec, args, spec.name, {}),
    });
  }

  private async drive(
    site: SiteBundle,
    spec: ToolSpec,
    args: Record<string, unknown>,
    label: string,
    extra: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const mutating = spec.effect === 'mutate';
    // ── The borrowed-ground gate ──────────────────────────────────────
    // Checked here as well as in the schema. The schema stops a
    // well-behaved caller; this stops every caller, including one that
    // reaches the handler by another path.
    if (mutating) {
      const grant = typeof args?.authorized_by === 'string' ? args.authorized_by.trim() : '';
      if (!grant) {
        return {
          success: false,
          error:
            `refused: '${label}' MUTATES the host (${spec.describes ?? 'effect unknown'}). ` +
            'Pass authorized_by with the operator\'s explicit go-ahead for this specific action.',
        };
      }
      this.logger.warn(
        { tool: label, site: site.id, authorizedBy: grant },
        'driving a mutating control under an explicit grant',
      );
    }

    if (isDesktop(site)) return this.desktopPlan(site, spec, args, extra);

    if (isNative(site)) {
      const verb: AxVerb = spec.kind;
      const flags = mutating ? ['--authorized-by', String(args.authorized_by).trim()] : [];
      const input = typeof args?.value === 'string' ? { value: args.value } : {};
      return this.axDrive(site, spec, verb, input, flags, extra);
    }

    // ── Refuse to act on the wrong console ────────────────────────────
    // A generated tool is registered for every loaded site, so nothing
    // stops one being called while the tab is somewhere else entirely.
    // Running a profile's JavaScript against a different page is at best
    // nonsense and at worst a click on a stranger's control.
    const urlRes = await this.evaluate('window.location.href');
    if (!urlRes.ok) return { success: false, error: urlRes.error };
    const url = String(urlRes.value ?? '');

    if (spec.kind !== 'goto' && !(site.match ?? []).some((m) => m && url.includes(m))) {
      return {
        success: false,
        error:
          `refused: '${label}' belongs to profile '${site.id}', but the active tab is ${url}. ` +
          'Navigate there first, or call site_context to see which profile is live.',
      };
    }

    if (spec.input) {
      const typed = await this.typeInto(spec, args);
      if (!typed.ok) return { success: false, error: typed.error };
      return {
        success: true,
        data: { site: site.id, page: spec.page, kind: spec.kind, ...extra, result: { typed: true, submitted: spec.input.submit } },
      };
    }

    const evalRes = await this.evaluate(spec.js ?? '');
    if (!evalRes.ok) return { success: false, error: evalRes.error };
    const value = evalRes.value ?? null;
    return {
      success: true,
      data: {
        site: site.id,
        page: spec.page,
        kind: spec.kind,
        ...extra,
        ...(spec.url_template ? { urlTemplate: spec.url_template } : {}),
        ...(spec.tab ? { tab: spec.tab } : {}),
        result: value,
      },
    };
  }
}

export class SiteToolProviderFactory extends BaseProviderFactory<SiteToolProvider> {
  create(deps: ProviderDependencies & { siteBundlePath?: string }): SiteToolProvider {
    const config: SiteToolProviderConfig = {
      name: 'site-plugins',
      description: 'MCP tools generated from declarative web-console profiles',
      bundlePath: deps.siteBundlePath || process.env.CURUPIRA_SITES_BUNDLE || defaultBundlePath(),
      perPageTools: deps.sitePerPageTools ?? process.env.CURUPIRA_SITES_PER_PAGE_TOOLS === 'true',
      useStack: !deps.siteBundlePath && process.env.CURUPIRA_SITES_SOURCE !== 'bundle',
    };
    return new SiteToolProvider(
      deps.chromeService as IChromeService,
      this.createProviderLogger(deps, 'site-plugins') as ILogger,
      deps.validator as IValidator,
      config,
    );
  }
}
