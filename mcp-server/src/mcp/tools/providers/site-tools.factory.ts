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
    this.registerContextTools();
    for (const site of this.bundle.sites) {
      for (const spec of site.tools) {
        this.registerGeneratedTool(site, spec);
      }
      if (site.tests && site.tests.length > 0) {
        this.registerTestRunner(site);
      }
    }
    this.logger.info(
      {
        sites: this.bundle.sites.length,
        tools: this.bundle.sites.reduce((n, s) => n + s.tools.length, 0),
      },
      'site plugins loaded',
    );
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
    const noArgs = {
      parse: (v: unknown) => (v || {}) as Record<string, unknown>,
      safeParse: (v: unknown) => ({ success: true as const, data: (v || {}) as Record<string, unknown> }),
    };
    this.registerTool({
      name: `${site.id.replace(/[^a-z0-9]+/gi, '_')}_run_tests`,
      description:
        `Run the qualifying test suite for the '${site.id}' console: for each case, navigate to the page, ` +
        `survey it, run its read-checks, and report which expectations held. Read-only. ` +
        `${(site.tests ?? []).length} case(s) on hand.`,
      argsSchema: noArgs,
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const cases: Array<{ name: string; passed: boolean; failures: string[] }> = [];
        for (const t of site.tests ?? []) {
          const target = site.base_url.replace(/\/+$/, '') + t.route;
          await this.evaluate(`location.href = ${JSON.stringify(target)}`);
          await this.waitForUrl(t.route, 8000);
          if (t.tab) {
            const label = JSON.stringify(t.tab);
            await this.evaluate(
              `(()=>{const b=[...document.querySelectorAll('button,[role="tab"],a')].find(e=>((e).innerText||'').trim()===${label});if(b)(b).click();})()`,
            );
          }
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
      },
    });
  }

  /** Poll the tab URL until it reflects `route` or the deadline passes. */
  private async waitForUrl(route: string, timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const res = await this.evaluate('window.location.href');
      if (res.ok && String(res.value ?? '').includes(route)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private async evaluate(expression: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const client = this.chromeService.getCurrentClient();
    if (!client) {
      return {
        ok: false,
        error: 'not connected to Chrome — run chrome_connect first (site tools drive an existing tab)',
      };
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
    const noArgs = {
      parse: (v: unknown) => v || {},
      safeParse: (v: unknown) => ({ success: true as const, data: v || {} }),
    };

    this.registerTool({
      name: 'site_context',
      description:
        'Report which console profile matches the active browser tab, and what that profile exposes. This is how curupira knows which site it is looking at.',
      argsSchema: noArgs,
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const res = await this.evaluate('window.location.href');
        if (!res.ok) return { success: false, error: res.error };
        const url = String(res.value ?? '');
        const matches = this.sitesForUrl(url);

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
            tools: matches[0]?.tools.map((t) => t.name) ?? [],
            mutatingTools:
              matches[0]?.tools.filter((t) => t.effect === 'mutate').map((t) => t.name) ?? [],
            loadedSites: this.bundle.sites.map((s) => s.id),
          },
        };
      },
    });

    this.registerTool({
      name: 'site_list',
      description: 'List every loaded console profile and the tools it provides.',
      argsSchema: noArgs,
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({
        success: true,
        data: {
          sites: this.bundle.sites.map((s) => ({
            id: s.id,
            baseUrl: s.base_url,
            match: s.match,
            tools: s.tools.length,
            mutating: s.tools.filter((t) => t.effect === 'mutate').length,
          })),
        },
      }),
    });
  }

  private registerGeneratedTool(site: SiteBundle, spec: ToolSpec): void {
    const mutating = spec.effect === 'mutate';

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
      argsSchema: {
        parse: (v: unknown) => (v || {}) as Record<string, unknown>,
        safeParse: (v: unknown) => ({ success: true as const, data: (v || {}) as Record<string, unknown> }),
      },
      // Always present. Without it the base provider substitutes
      // {additionalProperties:true}, which advertises that the tool accepts
      // anything and turns a schema rejection into a runtime failure.
      jsonSchema: spec.json_schema,
      handler: async (args: Record<string, unknown>) => {
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
                `refused: '${spec.name}' MUTATES the host (${spec.describes ?? 'effect unknown'}). ` +
                'Pass authorized_by with the operator\'s explicit go-ahead for this specific action.',
            };
          }
          this.logger.warn(
            { tool: spec.name, site: site.id, authorizedBy: grant },
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
              `refused: '${spec.name}' belongs to profile '${site.id}', but the active tab is ${url}. ` +
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
            ...(spec.url_template ? { urlTemplate: spec.url_template } : {}),
            ...(spec.tab ? { tab: spec.tab } : {}),
            result: value,
          },
        };
      },
    });
  }
}

export class SiteToolProviderFactory extends BaseProviderFactory<SiteToolProvider> {
  create(deps: ProviderDependencies & { siteBundlePath?: string }): SiteToolProvider {
    const config: SiteToolProviderConfig = {
      name: 'site-plugins',
      description: 'MCP tools generated from declarative web-console profiles',
      bundlePath: deps.siteBundlePath || process.env.CURUPIRA_SITES_BUNDLE || defaultBundlePath(),
    };
    return new SiteToolProvider(
      deps.chromeService as IChromeService,
      this.createProviderLogger(deps, 'site-plugins') as ILogger,
      deps.validator as IValidator,
      config,
    );
  }
}
