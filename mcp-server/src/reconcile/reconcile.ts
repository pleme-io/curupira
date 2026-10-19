import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  OFF,
  buildStack,
  cdp,
  currentPosture,
  defaultProfile,
  ensureChrome,
  hostOf,
  inWindow,
  isSignedOut,
  postureTabs,
  stateFile,
  warm,
  type Posture,
  type WarmReport,
  type WarmTab,
  type WarmTarget,
} from '../warm/warm.js';
import { converge } from '../guard/converge.js';
import { enforceMemory, type MemoryEvent, type MemorySample } from '../guard/memory.js';
import { budgetOf, type Budget } from '../guard/tabs.js';

export const BUILTIN_ALLOW = ['devtools://', 'chrome-extension://', 'chrome://', 'about:blank'];

export type Verdict = 'questioned' | 'adopted' | 'dismissed' | 'closed';

export interface Stray {
  host: string;
  url: string;
  title?: string;
  first_seen: number;
  last_seen: number;
  verdict: Verdict;
}

export type StrayBook = Record<string, Stray>;

export interface ReconcileReport {
  at: number;
  posture: string;
  state: 'idle' | 'converged' | 'converging' | 'limited' | 'blind' | 'held';
  reason?: string;
  tick_seconds: number;
  desired: number;
  missing: string[];
  opened: string[];
  strays: Stray[];
  newlyQuestioned: string[];
  closed: string[];
  pages?: number;
  max_tabs?: number;
  deduped?: Array<{ id: string; url: string; why: string }>;
  signedOut?: string[];
  signedOutHosts?: string[];
  overBudget?: string[];
  flapping?: string[];
  memoryOver?: { chrome_mb: number; budget_mb: number };
  memory?: { state: MemorySample['state']; pages: number; chrome_mb?: number; largest?: { url: string; heap_mb?: number }; frozen: number; events: MemoryEvent[] };
  warm?: WarmReport;
  errors: string[];
}

export interface ReconcileOptions {
  port: number;
  profile?: string;
  chromeBin?: string;
  stackBin?: string;
  now?: Date;
}

const stateDir = (): string => path.dirname(stateFile());
export const strayFile = (): string => path.join(stateDir(), 'strays.json');
export const reportFile = (): string => path.join(stateDir(), 'reconcile-last.json');
const leaseFile = (): string => path.join(stateDir(), 'reconcile.lease');

export function readStrays(): StrayBook {
  try {
    return JSON.parse(fs.readFileSync(strayFile(), 'utf8')) as StrayBook;
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function lastReport(): ReconcileReport | null {
  try {
    return JSON.parse(fs.readFileSync(reportFile(), 'utf8')) as ReconcileReport;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function takeLease(tickSeconds: number, now = Date.now()): boolean {
  try {
    const held = JSON.parse(fs.readFileSync(leaseFile(), 'utf8')) as { pid: number; at: number };
    if (held.pid !== process.pid && alive(held.pid) && now - held.at < tickSeconds * 3000) return false;
  } catch {
    /* no lease yet */
  }
  writeJson(leaseFile(), { pid: process.pid, at: now });
  return true;
}

export function isAllowed(url: string, allow: string[] = []): boolean {
  return [...BUILTIN_ALLOW, ...allow].some((a) => url.startsWith(a) || url.includes(a));
}

export function findStrays(open: WarmTarget[], desired: WarmTab[], allow: string[] = []): WarmTarget[] {
  const hosts = new Set(desired.map((t) => hostOf(t.url)));
  return open.filter((t) => t.type === 'page' && !isAllowed(t.url, allow) && !isSignedOut(t.url) && !hosts.has(hostOf(t.url)));
}

export function strayKey(url: string): string {
  return hostOf(url) || url;
}

export function mergeStrays(book: StrayBook, seen: WarmTarget[], now: number): { book: StrayBook; fresh: string[] } {
  const next: StrayBook = {};
  const fresh: string[] = [];
  for (const t of seen) {
    const key = strayKey(t.url);
    const prior = book[key] ?? next[key];
    if (!prior) fresh.push(key);
    next[key] = {
      host: key,
      url: t.url,
      title: (t as WarmTarget & { title?: string }).title,
      first_seen: prior?.first_seen ?? now,
      last_seen: now,
      verdict: prior?.verdict === 'closed' ? 'questioned' : (prior?.verdict ?? 'questioned'),
    };
  }
  for (const [key, s] of Object.entries(book)) if (!next[key] && s.verdict === 'adopted') next[key] = s;
  return { book: next, fresh: [...new Set(fresh)] };
}

function notify(posture: Posture, title: string, body: string, errors: string[]): void {
  if (!posture.notify) return;
  try {
    execFileSync(posture.notify, ['send', '-a', 'curupira', '-u', 'normal', title, body], { stdio: 'ignore' });
  } catch (err) {
    errors.push(`notify: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function guardMemory(report: ReconcileReport, port: number, budget: Budget, now: Date): Promise<void> {
  try {
    const { sample, events } = await enforceMemory(port, budget, now.getTime());
    if (!sample) return;
    const largest = sample.tabs.find((t) => t.heap_mb !== undefined);
    report.memory = {
      state: sample.state,
      pages: sample.pages,
      chrome_mb: sample.chrome.rss_mb,
      largest: largest ? { url: largest.url, heap_mb: largest.heap_mb } : undefined,
      frozen: sample.tabs.filter((t) => t.state === 'frozen').length,
      events,
    };
  } catch (err) {
    report.errors.push(`memory: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileReport> {
  const now = opts.now ?? new Date();
  const name = currentPosture();
  const report: ReconcileReport = { at: now.getTime(), posture: name, state: 'idle', tick_seconds: 60, desired: 0, missing: [], opened: [], strays: [], newlyQuestioned: [], closed: [], errors: [] };
  let bundle: ReturnType<typeof buildStack> | null = null;
  try {
    bundle = buildStack(opts.stackBin ?? (process.env.CURUPIRA_STACK_BIN || 'curupira-stack'));
  } catch (err) {
    if (name !== OFF) throw err;
  }
  const budget = budgetOf(bundle);
  if (name === OFF) {
    if (budget.enabled && takeLease(60, now.getTime())) await guardMemory(report, opts.port, budget, now);
    return settle({ ...report, reason: 'posture is off' });
  }
  const posture = (bundle?.postures ?? []).find((p) => p.name === name);
  if (!bundle || !posture) return settle({ ...report, reason: `posture '${name}' is not in the stack`, errors: [`unknown posture '${name}'`] });
  const rc = posture.reconcile;
  if (!rc) return settle({ ...report, reason: `posture '${name}' declares no reconcile block` });
  report.tick_seconds = rc.tick_seconds;
  if (!takeLease(rc.tick_seconds, now.getTime())) return { ...report, state: 'held', reason: 'another curupira holds the reconcile lease' };
  if (!inWindow(now, posture.hours, posture.days)) {
    if (budget.enabled) await guardMemory(report, opts.port, budget, now);
    return settle({ ...report, reason: `outside posture '${name}' hours` });
  }

  const profile = opts.profile ?? defaultProfile();
  const base = `http://127.0.0.1:${opts.port}`;
  const desired = postureTabs(bundle, posture);
  report.desired = desired.length;
  report.max_tabs = budget.max_tabs;

  if (rc.tabs === 'enforce') {
    const chrome = await ensureChrome(opts.port, profile, opts.chromeBin);
    if (chrome.error) return settle({ ...report, state: 'blind', reason: chrome.error, errors: [chrome.error] });
  }
  let targets: WarmTarget[];
  try {
    targets = (await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as WarmTarget[];
  } catch (err) {
    return settle({ ...report, state: 'blind', reason: `Chrome on port ${opts.port} did not answer`, errors: [String(err)] });
  }

  if (budget.enabled) await guardMemory(report, opts.port, budget, now);

  if (rc.tabs !== 'off') {
    const tabs = await converge({ port: opts.port, desired, sites: bundle.sites ?? [], budget, open: targets, enforce: rc.tabs === 'enforce', now: now.getTime() });
    const plan = tabs.plan;
    report.missing = [...plan.open.map((t) => t.key), ...plan.signedOut, ...plan.overBudget, ...plan.flapping];
    report.opened = tabs.opened;
    report.pages = plan.pages + tabs.opened.length;
    report.deduped = tabs.deduped;
    report.signedOut = plan.signedOut;
    report.signedOutHosts = plan.signedOutHosts;
    report.overBudget = plan.overBudget;
    report.flapping = plan.flapping;
    if (tabs.memoryOver) report.memoryOver = tabs.memoryOver;
    report.errors.push(...tabs.errors);
    const gone = new Set(tabs.deduped.map((d) => d.id));
    targets = targets.filter((t) => !gone.has(t.id));
  }

  if (rc.strays !== 'ignore') {
    const seen = findStrays(targets, desired, rc.allow);
    const { book, fresh } = mergeStrays(readStrays(), seen, now.getTime());
    if (rc.strays === 'close') {
      for (const t of seen) {
        const key = strayKey(t.url);
        if (book[key]?.verdict === 'adopted' || book[key]?.verdict === 'dismissed') continue;
        try {
          await fetch(`${base}/json/close/${t.id}`);
          report.closed.push(key);
          if (book[key]) book[key].verdict = 'closed';
        } catch (err) {
          report.errors.push(`close ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      report.newlyQuestioned = fresh.filter((k) => book[k]?.verdict === 'questioned');
      if (report.newlyQuestioned.length > 0) {
        notify(posture, `curupira: tab outside posture '${name}'`, `${report.newlyQuestioned.join(', ')}: adopt, dismiss or close (site_posture_stray)`, report.errors);
      }
    }
    writeJson(strayFile(), book);
    report.strays = Object.values(book);
  }

  try {
    report.warm = await warm({ posture: name, port: opts.port, profile, chromeBin: opts.chromeBin, stackBin: opts.stackBin, now, open: false });
  } catch (err) {
    report.errors.push(`warm: ${err instanceof Error ? err.message : String(err)}`);
  }

  const open = report.strays.filter((s) => s.verdict === 'questioned').length;
  const actionable = report.missing.length - (report.signedOut?.length ?? 0) - (report.overBudget?.length ?? 0) - (report.flapping?.length ?? 0) - report.opened.length;
  report.state = open > 0 || actionable > 0 || report.opened.length > 0 ? 'converging' : report.missing.length > report.opened.length ? 'limited' : 'converged';
  if (report.state === 'limited') {
    report.reason = [
      report.signedOut?.length ? `${report.signedOut.length} tab(s) wait on a sign-in at ${report.signedOutHosts?.join(', ')}` : '',
      report.overBudget?.length ? `${report.overBudget.length} tab(s) over the ${budget.max_tabs}-tab budget${report.memoryOver ? ' or the Chrome memory budget' : ''}` : '',
      report.flapping?.length ? `${report.flapping.length} tab(s) reopened too often in the last hour: ${report.flapping.join(', ')}` : '',
    ].filter(Boolean).join('; ');
  }
  return settle(report);
}

function settle(report: ReconcileReport): ReconcileReport {
  writeJson(reportFile(), report);
  return report;
}

export async function resolveStray(key: string, action: 'adopt' | 'dismiss' | 'close', port: number): Promise<Stray> {
  const book = readStrays();
  const stray = book[key];
  if (!stray) throw new Error(`no stray '${key}'; known: ${Object.keys(book).join(', ') || 'none'}`);
  if (action === 'close') {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as WarmTarget[];
    for (const t of targets.filter((x) => x.type === 'page' && strayKey(x.url) === key)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
  }
  stray.verdict = action === 'adopt' ? 'adopted' : action === 'dismiss' ? 'dismissed' : 'closed';
  writeJson(strayFile(), book);
  return stray;
}

export function startReconciler(opts: ReconcileOptions, log: (r: ReconcileReport) => void = () => {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = async (): Promise<void> => {
    if (stopped) return;
    let next = 60;
    try {
      const r = await reconcileOnce(opts);
      log(r);
      next = r.tick_seconds;
    } catch {
      next = 60;
    }
    if (!stopped) timer = setTimeout(loop, next * 1000);
  };
  timer = setTimeout(loop, 1000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
