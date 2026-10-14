import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findChromeBinary, waitForCDP } from '../mcp/tools/providers/chrome-launch-tools.factory.js';

export interface WarmTab {
  key: string;
  url: string;
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
}

export interface WarmOptions {
  posture: string;
  port: number;
  profile: string;
  chromeBin?: string;
  now?: Date;
  stackBin?: string;
  force?: boolean;
}

interface StackBundle {
  workspaces?: WarmWorkspace[];
  postures?: Posture[];
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
  errors: string[];
}

const SIGNED_OUT_MARKERS = [
  'accounts.google.com',
  'id.atlassian.com/login',
  '/account/login',
  '/login',
  '/signin',
  '/sign-in',
  '/auth/realms/',
];

export function isSignedOut(url: string): boolean {
  return SIGNED_OUT_MARKERS.some((m) => url.includes(m));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function inWindow(now: Date, hours?: [number, number], days?: number[]): boolean {
  if (days && days.length > 0 && !days.includes(now.getDay())) return false;
  if (hours) {
    const h = now.getHours();
    if (h < hours[0] || h >= hours[1]) return false;
  }
  return true;
}

export function presenceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/${u.pathname.split('/')[1]}`;
  } catch {
    return '';
  }
}

export function missingTabs(tabs: WarmTab[], open: WarmTarget[]): WarmTab[] {
  const seen = new Set(open.filter((t) => t.type === 'page').map((t) => presenceKey(t.url)));
  return tabs.filter((tab) => {
    const key = presenceKey(tab.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


async function cdp(wsUrl: string, method: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot open ${wsUrl}`));
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      ws.onmessage = (m) => {
        const d = JSON.parse(String(m.data));
        if (d.id === 1) {
          clearTimeout(timer);
          d.error ? reject(new Error(d.error.message)) : resolve(d.result);
        }
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
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
  const found = (bundle.workspaces ?? []).filter((w) => posture.workspaces.includes(w.name));
  const tabs = found.flatMap((w) => w.tabs);
  const signin = posture.signin ?? [];
  const base = `http://127.0.0.1:${opts.port}`;

  let up = await fetch(`${base}/json/version`).then((r) => r.ok).catch(() => false);
  if (!up) {
    const bin = opts.chromeBin || findChromeBinary();
    if (!bin) {
      report.errors.push('no Chrome binary to launch');
      return report;
    }
    spawn(bin, [`--remote-debugging-port=${opts.port}`, `--user-data-dir=${opts.profile}`, '--no-first-run', '--no-default-browser-check'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    report.launched = true;
    up = await waitForCDP('127.0.0.1', opts.port, 30000);
    if (!up) {
      report.errors.push(`Chrome on port ${opts.port} never answered`);
      return report;
    }
  }

  const version = (await (await fetch(`${base}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  let targets = (await (await fetch(`${base}/json/list`)).json()) as WarmTarget[];
  const missing = missingTabs(tabs, targets);
  report.present = tabs.filter((t) => !missing.includes(t)).map((t) => t.key);
  for (const t of missing) {
    try {
      await cdp(version.webSocketDebuggerUrl, 'Target.createTarget', { url: t.url, background: true });
      report.opened.push(t.key);
    } catch (err) {
      report.errors.push(`open ${t.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

export function defaultProfile(): string {
  return process.env.CURUPIRA_WORKSPACE_CHROME_PROFILE || path.join(os.homedir(), '.config', 'curupira', 'chrome-workspace');
}
