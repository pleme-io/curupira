import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Budget {
  enabled: boolean;
  max_tabs: number;
  tab_memory_mb: number;
  chrome_memory_mb: number;
  sample_seconds: number;
  cdp_timeout_ms: number;
  over: 'reload' | 'close';
}

export const DEFAULT_BUDGET: Budget = {
  enabled: true,
  max_tabs: 30,
  tab_memory_mb: 1536,
  chrome_memory_mb: 8192,
  sample_seconds: 60,
  cdp_timeout_ms: 4000,
  over: 'reload',
};

export function budgetOf(bundle: { budget?: Partial<Budget> } | null | undefined): Budget {
  return { ...DEFAULT_BUDGET, ...(bundle?.budget ?? {}) };
}

export interface GuardSite {
  id: string;
  base_url?: string;
  match?: string[];
  target?: string;
  tools?: Array<{ kind: string; page: string; url_template?: string }>;
}

export interface DesiredTab {
  key: string;
  url: string;
  site?: string;
  page?: string;
}

export interface OpenPage {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface Route {
  key: string;
  hosts: Set<string>;
  path: RegExp;
  query: Array<[string, string]>;
  order: number[];
}

const BUILTIN = /^(devtools|chrome|chrome-extension|chrome-untrusted|about):/;

const SIGNED_OUT_MARKERS = [
  'accounts.google.com',
  'id.atlassian.com/login',
  '/account/login',
  '/login',
  '/signin',
  '/sign-in',
  '-signin',
  '/auth/realms/',
];

const REDIRECT_PARAMS = ['next', 'targetUri', 'return_to', 'returnTo', 'redirect', 'redirect_to', 'redirectTo', 'redirect_uri', 'redir', 'continue', 'returnUrl', 'return_url'];

const PLACEHOLDER = /\{[^}]+\}/g;

export function isSignedOut(url: string): boolean {
  return SIGNED_OUT_MARKERS.some((m) => url.includes(m));
}

export function isCountable(page: OpenPage): boolean {
  return page.type === 'page' && !BUILTIN.test(page.url);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function redirectTarget(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const p of REDIRECT_PARAMS) {
    const v = u.searchParams.get(p);
    if (!v) continue;
    try {
      const target = new URL(v, u.origin);
      if (target.protocol === 'http:' || target.protocol === 'https:') return target.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRoutes(sites: GuardSite[] = []): Route[] {
  const out: Route[] = [];
  sites.forEach((site, si) => {
    if (site.target && site.target !== 'browser') return;
    const hosts = new Set<string>([...(site.match ?? []), hostOf(site.base_url ?? '')].filter(Boolean));
    (site.tools ?? []).forEach((tool, ti) => {
      if (tool.kind !== 'goto' || !tool.url_template) return;
      const marked = tool.url_template.replace(PLACEHOLDER, 'CURUPIRAHOLE');
      let u: URL;
      try {
        u = new URL(marked);
      } catch {
        return;
      }
      hosts.add(u.host);
      const segments = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      const literal = segments.filter((s) => !s.includes('CURUPIRAHOLE')).length;
      const pattern = segments.map((s) => escape(decodeURIComponent(s)).replace(/CURUPIRAHOLE/g, '[^/]+')).join('/');
      const query = [...u.searchParams.entries()].filter(([, v]) => v !== '' && !v.includes('CURUPIRAHOLE'));
      out.push({
        key: `${site.id}/${tool.page}`,
        hosts,
        path: new RegExp(`^/${pattern}/?$`),
        query,
        order: [literal, -segments.length, -si, -ti],
      });
    });
  });
  return out;
}

function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

export function routeKey(url: string, routes: Route[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  let best: { key: string; rank: number[] } | null = null;
  for (const r of routes) {
    if (!r.hosts.has(u.host) || !r.path.test(path)) continue;
    const hits = r.query.filter(([k, v]) => u.searchParams.get(k) === v).length;
    const rank = [r.order[0], hits, hits - r.query.length, ...r.order.slice(1)];
    if (!best || better(rank, best.rank)) best = { key: r.key, rank };
  }
  return best?.key ?? null;
}

export function keyOf(url: string, routes: Route[]): string {
  return routeKey(url, routes) ?? urlKey(url);
}

export function pageKeys(page: OpenPage, routes: Route[]): string[] {
  const keys = [keyOf(page.url, routes)];
  if (isSignedOut(page.url)) {
    const target = redirectTarget(page.url);
    if (target) keys.push(keyOf(target, routes));
  }
  return keys;
}

export interface LedgerEntry {
  key: string;
  url: string;
  opened_at: number;
}

export interface Ledger {
  targets: Record<string, LedgerEntry>;
  opens: Record<string, number[]>;
}

export function ledgerFile(): string {
  const posture = process.env.CURUPIRA_POSTURE_FILE || path.join(os.homedir(), '.local', 'state', 'curupira', 'posture');
  return path.join(path.dirname(posture), 'tabs.json');
}

export function readLedger(): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) as Partial<Ledger>;
    return { targets: raw.targets ?? {}, opens: raw.opens ?? {} };
  } catch {
    return { targets: {}, opens: {} };
  }
}

export function writeLedger(ledger: Ledger): void {
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger, null, 2) + '\n');
}

export const FLAP_WINDOW_MS = 3600_000;
export const FLAP_LIMIT = 3;

export function recordOpen(ledger: Ledger, id: string, tab: DesiredTab, key: string, now: number): void {
  ledger.targets[id] = { key, url: tab.url, opened_at: now };
  ledger.opens[key] = [...(ledger.opens[key] ?? []).filter((t) => now - t < FLAP_WINDOW_MS), now];
}

export interface Closing {
  id: string;
  url: string;
  why: 'duplicate' | 'signed-out-duplicate';
}

export interface TabPlan {
  present: Record<string, string>;
  open: Array<DesiredTab & { tabKey: string }>;
  signedOut: string[];
  signedOutHosts: string[];
  overBudget: string[];
  flapping: string[];
  close: Closing[];
  pages: number;
  maxTabs: number;
}

export interface PlanInput {
  desired: DesiredTab[];
  open: OpenPage[];
  ledger: Ledger;
  routes: Route[];
  budget: Budget;
  now: number;
  closeDuplicates: boolean;
}

export function planTabs(input: PlanInput): TabPlan {
  const { desired, ledger, routes, budget, now } = input;
  const pages = input.open.filter(isCountable);
  const live = new Set(pages.map((p) => p.id));
  for (const id of Object.keys(ledger.targets)) if (!live.has(id)) delete ledger.targets[id];

  const wanted = new Map<string, DesiredTab>();
  for (const t of desired) {
    const k = keyOf(t.url, routes);
    if (!wanted.has(k)) wanted.set(k, t);
  }
  const wantedHost = new Map([...wanted].map(([k, t]) => [k, hostOf(t.url)]));

  const keysOf = new Map<string, string[]>();
  for (const p of pages) {
    const keys = pageKeys(p, routes);
    const managed = ledger.targets[p.id]?.key;
    keysOf.set(p.id, managed ? [managed, ...keys] : keys);
  }

  const close: Closing[] = [];
  const closing = new Set<string>();
  const signedOutHosts = new Set<string>();
  const signinGroups = new Map<string, OpenPage>();
  const ordered = [...pages].sort((a, b) => Number(!!ledger.targets[b.id]) - Number(!!ledger.targets[a.id]));
  for (const p of ordered.filter((x) => isSignedOut(x.url))) {
    const keys = keysOf.get(p.id) ?? [];
    const hosts = new Set<string>([hostOf(p.url), hostOf(redirectTarget(p.url) ?? '')]);
    for (const k of keys) if (wantedHost.has(k)) hosts.add(wantedHost.get(k) as string);
    hosts.delete('');
    for (const h of hosts) signedOutHosts.add(h);
    const g = keys.map((k) => wantedHost.get(k)).find(Boolean) || hostOf(redirectTarget(p.url) ?? '') || hostOf(p.url);
    if (!signinGroups.has(g)) signinGroups.set(g, p);
    else if (input.closeDuplicates) {
      close.push({ id: p.id, url: p.url, why: 'signed-out-duplicate' });
      closing.add(p.id);
    }
  }

  const present: Record<string, string> = {};
  for (const p of ordered) {
    if (closing.has(p.id)) continue;
    for (const k of keysOf.get(p.id) ?? []) {
      if (!wanted.has(k)) continue;
      if (!present[k]) {
        present[k] = p.id;
      } else if (input.closeDuplicates && ledger.targets[p.id] && present[k] !== p.id) {
        close.push({ id: p.id, url: p.url, why: 'duplicate' });
        closing.add(p.id);
        break;
      }
    }
  }

  const remaining = pages.length - closing.size;
  let room = Math.max(0, budget.max_tabs - remaining);
  const plan: TabPlan = {
    present,
    open: [],
    signedOut: [],
    signedOutHosts: [...signedOutHosts].sort(),
    overBudget: [],
    flapping: [],
    close,
    pages: remaining,
    maxTabs: budget.max_tabs,
  };
  for (const [k, t] of wanted) {
    if (present[k]) continue;
    if (signedOutHosts.has(hostOf(t.url))) {
      plan.signedOut.push(t.key);
      continue;
    }
    if ((ledger.opens[k] ?? []).filter((at) => now - at < FLAP_WINDOW_MS).length >= FLAP_LIMIT) {
      plan.flapping.push(t.key);
      continue;
    }
    if (budget.enabled && room <= 0) {
      plan.overBudget.push(t.key);
      continue;
    }
    plan.open.push({ ...t, tabKey: k });
    room -= 1;
  }
  return plan;
}

export function closeCandidates(open: OpenPage[], plan: TabPlan, routes: Route[], desired: DesiredTab[]): Array<{ id: string; url: string; why: string }> {
  const wanted = new Set(desired.map((t) => keyOf(t.url, routes)));
  const kept = new Set(Object.values(plan.present));
  return open
    .filter(isCountable)
    .filter((p) => !kept.has(p.id))
    .map((p) => ({
      id: p.id,
      url: p.url,
      why: isSignedOut(p.url) ? 'signed out' : pageKeys(p, routes).some((k) => wanted.has(k)) ? 'duplicate of a kept tab' : 'outside the requested set',
    }))
    .sort((a, b) => Number(b.why === 'signed out') - Number(a.why === 'signed out'));
}
