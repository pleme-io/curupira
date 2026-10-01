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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type BaseToolProviderConfig } from '../base-tool-provider.js';
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
  js: string;
  url_template?: string;
  tab?: string;
  effect?: 'observe' | 'mutate';
  describes?: string;
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

interface SiteBundle {
  id: string;
  base_url: string;
  match: string[];
  tools: ToolSpec[];
  tests?: CompiledTest[];
}

interface Bundle {
  schema_version: number;
  sites: SiteBundle[];
}

// ── The judge — a byte-for-byte port of curupira-sites::testplan ─────────────
// Kept identical to the Rust so a verdict is the same whichever executor ran it.

function judgeSurvey(test: CompiledTest, survey: Record<string, unknown>): string[] {
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

function judgeRead(check: CompiledReadCheck, result: Record<string, unknown>): string | null {
  const got = typeof result.status === 'string' ? result.status : '<no status>';
  return got === check.expect_status
    ? null
    : `read '${check.read}': expected ${check.expect_status}, got ${got}`;
}

function judgeCase(
  test: CompiledTest,
  survey: Record<string, unknown>,
  readResults: Array<Record<string, unknown>>,
): { name: string; passed: boolean; failures: string[] } {
  const failures = judgeSurvey(test, survey);
  const checks = test.read_checks ?? [];
  checks.forEach((check, i) => {
    const f = judgeRead(check, readResults[i] ?? {});
    if (f) failures.push(f);
  });
  if (readResults.length !== checks.length) {
    failures.push(`executor ran ${readResults.length} read-checks, plan has ${checks.length}`);
  }
  return { name: test.name, passed: failures.length === 0, failures };
}

/** The bundle schema this provider understands. */
const SUPPORTED_SCHEMA = 1;

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

export interface SiteToolProviderConfig extends BaseToolProviderConfig {
  bundlePath: string;
  perPageTools: boolean;
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
    this.loadBundle();
    this.entries = this.bundle.sites.map(catalogue);
    this.registerContextTools();
    this.registerGenericTools();
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
          },
          required: ['site', 'page', 'control'],
          additionalProperties: false,
        },
        handler: async (args: Record<string, unknown>) => this.driveLeaf('site_act', 'control', args, actSites, hasControls),
      });
    }

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
          properties: { site: this.siteSchema(testSites) },
          required: ['site'],
          additionalProperties: false,
        },
        handler: async (args: Record<string, unknown>) => {
          const site = this.resolveSite(args.site, testSites);
          if (!site.ok) return { success: false, error: site.error };
          return this.runTests(site.value.site);
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
    const ready = await this.evaluate(goto.js);
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
  private loadBundle(): void {
    const p = this.config.bundlePath;
    if (!fs.existsSync(p)) {
      this.logger.debug({ path: p }, 'no site bundle; site plugins inactive');
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Bundle;
      if (parsed.schema_version !== SUPPORTED_SCHEMA) {
        this.logger.error(
          { path: p, found: parsed.schema_version, supported: SUPPORTED_SCHEMA },
          'site bundle schema mismatch; refusing to load it rather than mis-read its fields',
        );
        return;
      }
      this.bundle = parsed;
    } catch (err) {
      this.logger.error({ path: p, err }, 'site bundle unreadable; site plugins inactive');
    }
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

  private async runTests(site: SiteBundle): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const cases: Array<{ name: string; passed: boolean; failures: string[] }> = [];
    for (const t of site.tests ?? []) {
      const nav = await this.navigate(site.base_url.replace(/\/+$/, '') + t.route, t.tab);
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

  /** Which site claims a URL. First match wins; ambiguity is reported, not resolved. */
  private sitesForUrl(url: string): SiteBundle[] {
    return this.bundle.sites.filter((s) => s.match.some((m) => m && url.includes(m)));
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
        if (!res.ok) return { success: false, error: res.error };
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
            loadedSites: this.bundle.sites.map((s) => s.id),
          },
        };
      },
    });

    this.registerTool({
      name: 'site_list',
      description: 'List every loaded console profile with its pages, readable regions, controls and route params.',
      argsSchema: PERMISSIVE,
      jsonSchema: NO_ARGS_SCHEMA,
      handler: async () => ({
        success: true,
        data: {
          sites: this.entries.map(({ site: s, pages }) => ({
            id: s.id,
            baseUrl: s.base_url,
            match: s.match,
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

    // ── Refuse to act on the wrong console ────────────────────────────
    // A generated tool is registered for every loaded site, so nothing
    // stops one being called while the tab is somewhere else entirely.
    // Running a profile's JavaScript against a different page is at best
    // nonsense and at worst a click on a stranger's control.
    const urlRes = await this.evaluate('window.location.href');
    if (!urlRes.ok) return { success: false, error: urlRes.error };
    const url = String(urlRes.value ?? '');

    if (spec.kind !== 'goto' && !site.match.some((m) => m && url.includes(m))) {
      return {
        success: false,
        error:
          `refused: '${label}' belongs to profile '${site.id}', but the active tab is ${url}. ` +
          'Navigate there first, or call site_context to see which profile is live.',
      };
    }

    const evalRes = await this.evaluate(spec.js);
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
    };
    return new SiteToolProvider(
      deps.chromeService as IChromeService,
      this.createProviderLogger(deps, 'site-plugins') as ILogger,
      deps.validator as IValidator,
      config,
    );
  }
}
