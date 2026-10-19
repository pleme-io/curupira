import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findChromeBinary, waitForCDP } from '../mcp/tools/providers/chrome-launch-tools.factory.js';
import { cdpCall } from '../guard/cdp.js';
import { converge, type ConvergeReport } from '../guard/converge.js';
import { budgetOf, hostOf, isSignedOut, type Budget, type GuardSite } from '../guard/tabs.js';

export interface WarmTab {
  key: string;
  url: string;
  site?: string;
  page?: string;
}

export interface WarmWorkspace {
  name: string;
  tabs: WarmTab[];
}

export interface FormSignin {
  match: string;
  user_file: string;
  password_file: string;
  user_selector?: string;
  password_selector?: string;
}

export interface Posture {
  name: string;
  description?: string;
  workspaces: string[];
  hours?: [number, number];
  days?: number[];
  interval_minutes: number;
  signin?: FormSignin[];
  notify?: string;
  reconcile?: Reconcile;
}

export interface Reconcile {
  tick_seconds: number;
  tabs: 'enforce' | 'observe' | 'off';
  strays: 'question' | 'close' | 'ignore';
  allow?: string[];
}

export interface WarmOptions {
  posture: string;
  port: number;
  profile: string;
  chromeBin?: string;
  now?: Date;
  stackBin?: string;
  force?: boolean;
  open?: boolean;
}

export interface StackBundle {
  sites?: GuardSite[];
  workspaces?: WarmWorkspace[];
  postures?: Posture[];
  budget?: Partial<Budget>;
}

export const OFF = 'off';

export function stateFile(): string {
  return process.env.CURUPIRA_POSTURE_FILE || path.join(os.homedir(), '.local', 'state', 'curupira', 'posture');
}

export function currentPosture(): string {
  try {
    return fs.readFileSync(stateFile(), 'utf8').trim() || OFF;
  } catch {
    return OFF;
  }
}

export function setPosture(name: string): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), name + '\n');
}

export function buildStack(stackBin: string): StackBundle {
  return JSON.parse(execFileSync(stackBin, ['build'], { encoding: 'utf8', cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'] }));
}

export interface WarmTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface WarmReport {
  ran: boolean;
  reason?: string;
  launched: boolean;
  opened: string[];
  present: string[];
  signedOut: string[];
  refilled: string[];
  notified: boolean;
  tabs?: ConvergeReport;
  errors: string[];
}

export { hostOf, isSignedOut };

export function inWindow(now: Date, hours?: [number, number], days?: number[]): boolean {
  if (days && days.length > 0 && !days.includes(now.getDay())) return false;
  if (hours) {
    const h = now.getHours();
    if (h < hours[0] || h >= hours[1]) return false;
  }
  return true;
}

export async function cdp(wsUrl: string, method: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
  const r = await cdpCall(wsUrl, method, params, timeoutMs);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function formFill(user: string, pass: string, userSel: string, passSel: string): string {
  return `(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const u = document.querySelector(${JSON.stringify(userSel)}); const p = document.querySelector(${JSON.stringify(passSel)});
    if (!u || !p) return false;
    set(u, ${JSON.stringify(user)}); set(p, ${JSON.stringify(pass)});
    p.form && (p.form.requestSubmit ? p.form.requestSubmit() : p.form.submit());
    return true;
  })()`;
}

export async function warm(opts: WarmOptions): Promise<WarmReport> {
  const report: WarmReport = { ran: false, launched: false, opened: [], present: [], signedOut: [], refilled: [], notified: false, errors: [] };
  if (opts.posture === OFF) {
    report.reason = 'posture is off';
    return report;
  }
  const bundle = buildStack(opts.stackBin ?? (process.env.CURUPIRA_STACK_BIN || 'curupira-stack'));
  const posture = (bundle.postures ?? []).find((p) => p.name === opts.posture);
  if (!posture) {
    report.errors.push(`unknown posture '${opts.posture}'; legal: ${[OFF, ...(bundle.postures ?? []).map((p) => p.name)].join(', ')}`);
    return report;
  }
  const now = opts.now ?? new Date();
  if (!inWindow(now, posture.hours, posture.days)) {
    report.reason = `outside posture '${posture.name}' hours`;
    return report;
  }
  const stamp = path.join(path.dirname(stateFile()), `warm-last-${posture.name}`);
  const last = (() => { try { return Number(fs.readFileSync(stamp, 'utf8')); } catch { return 0; } })();
  if (!opts.force && now.getTime() - last < posture.interval_minutes * 60000) {
    report.reason = `ran less than ${posture.interval_minutes} min ago`;
    return report;
  }
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, String(now.getTime()));
  report.ran = true;
  const tabs = postureTabs(bundle, posture);
  const signin = posture.signin ?? [];
  const base = `http://127.0.0.1:${opts.port}`;

  const chrome = await ensureChrome(opts.port, opts.profile, opts.chromeBin);
  report.launched = chrome.launched;
  if (chrome.error) {
    report.errors.push(chrome.error);
    return report;
  }

  let targets = (await (await fetch(`${base}/json/list`)).json()) as WarmTarget[];
  if (opts.open !== false) {
    const tabsReport = await converge({ port: opts.port, desired: tabs, sites: bundle.sites ?? [], budget: budgetOf(bundle), open: targets, enforce: true, now: now.getTime() });
    report.tabs = tabsReport;
    report.opened = tabsReport.opened;
    report.present = Object.keys(tabsReport.plan.present);
    report.errors.push(...tabsReport.errors);
  }

  if (report.opened.length > 0) await new Promise((r) => setTimeout(r, 15000));
  targets = (await (await fetch(`${base}/json/list`)).json()) as WarmTarget[];
  const pages = targets.filter((t) => t.type === 'page');
  const out = pages.filter((p) => isSignedOut(p.url));

  for (const p of out) {
    const rule = signin.find((s) => p.url.includes(s.match));
    if (rule && p.webSocketDebuggerUrl) {
      try {
        const user = fs.readFileSync(rule.user_file, 'utf8').trim();
        const pass = fs.readFileSync(rule.password_file, 'utf8').trim();
        const res = await cdp(p.webSocketDebuggerUrl, 'Runtime.evaluate', {
          expression: formFill(user, pass, rule.user_selector ?? '#username, input[name=username]', rule.password_selector ?? '#password, input[type=password]'),
          returnByValue: true,
        });
        if (res?.result?.value === true) {
          report.refilled.push(hostOf(p.url));
          continue;
        }
      } catch (err) {
        report.errors.push(`refill ${hostOf(p.url)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    report.signedOut.push(hostOf(p.url));
  }
  report.signedOut = [...new Set(report.signedOut)];
  report.refilled = [...new Set(report.refilled)];

  if (report.signedOut.length > 0 && posture.notify) {
    try {
      execFileSync(posture.notify, ['send', '-a', 'curupira', '-u', 'normal', 'curupira: sign-in needed', report.signedOut.join(', ')], { stdio: 'ignore' });
      report.notified = true;
    } catch (err) {
      report.errors.push(`notify: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

export async function ensureChrome(port: number, profile: string, chromeBin?: string): Promise<{ launched: boolean; error?: string }> {
  const base = `http://127.0.0.1:${port}`;
  if (await fetch(`${base}/json/version`).then((r) => r.ok).catch(() => false)) return { launched: false };
  const bin = chromeBin || findChromeBinary();
  if (!bin) return { launched: false, error: 'no Chrome binary to launch' };
  spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  if (!(await waitForCDP('127.0.0.1', port, 30000))) return { launched: true, error: `Chrome on port ${port} never answered` };
  return { launched: true };
}

export function postureTabs(bundle: StackBundle, posture: Posture): WarmTab[] {
  return (bundle.workspaces ?? []).filter((w) => posture.workspaces.includes(w.name)).flatMap((w) => w.tabs);
}

export function defaultProfile(): string {
  return process.env.CURUPIRA_WORKSPACE_CHROME_PROFILE || path.join(os.homedir(), '.config', 'curupira', 'chrome-workspace');
}
