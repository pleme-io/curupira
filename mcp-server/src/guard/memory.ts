import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cdpCall, getJson } from './cdp.js';
import { isCountable, ledgerFile, type Budget, type OpenPage } from './tabs.js';

const MB = 1024 * 1024;
export const REPEAT_MS = 30 * 60_000;
const KEEP_EVENTS = 200;

export interface TabMemory {
  id: string;
  url: string;
  title?: string;
  state: 'sampled' | 'frozen' | 'blind';
  heap_mb?: number;
  error?: string;
}

export interface ChromeMemory {
  state: 'sampled' | 'blind';
  rss_mb?: number;
  processes?: Array<{ pid: number; type: string; rss_mb: number }>;
  error?: string;
}

export interface MemorySample {
  at: number;
  state: 'sampled' | 'blind';
  error?: string;
  pages: number;
  tabs: TabMemory[];
  chrome: ChromeMemory;
}

export interface MemoryEvent {
  at: number;
  kind: 'tab-over' | 'chrome-over';
  id: string;
  url: string;
  heap_mb?: number;
  chrome_mb?: number;
  action: 'reloaded' | 'closed' | 'none';
  reason: string;
  error?: string;
}

export interface MemoryBook {
  last_sample_at: number;
  reloaded: Record<string, number>;
  events: MemoryEvent[];
}

export function memoryFile(): string {
  return path.join(path.dirname(ledgerFile()), 'memory.json');
}

export function readMemoryBook(): MemoryBook {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryFile(), 'utf8')) as Partial<MemoryBook>;
    return { last_sample_at: raw.last_sample_at ?? 0, reloaded: raw.reloaded ?? {}, events: raw.events ?? [] };
  } catch {
    return { last_sample_at: 0, reloaded: {}, events: [] };
  }
}

function writeMemoryBook(book: MemoryBook): void {
  fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
  fs.writeFileSync(memoryFile(), JSON.stringify({ ...book, events: book.events.slice(-KEEP_EVENTS) }, null, 2) + '\n');
}

function rssOf(pids: number[]): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    if (pids.length === 0) return resolve(new Map());
    execFile('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], { timeout: 5000 }, (_err, stdout) => {
      const out = new Map<number, number>();
      for (const line of String(stdout ?? '').split('\n')) {
        const [pid, rss] = line.trim().split(/\s+/).map(Number);
        if (Number.isFinite(pid) && Number.isFinite(rss)) out.set(pid, rss / 1024);
      }
      resolve(out);
    });
  });
}

async function pool<T, R>(items: T[], width: number, work: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

export async function sampleChrome(port: number, timeoutMs: number): Promise<ChromeMemory> {
  try {
    const version = await getJson<{ webSocketDebuggerUrl: string }>(`http://127.0.0.1:${port}/json/version`);
    const info = await cdpCall(version.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo', {}, timeoutMs);
    if (!info.ok) return { state: 'blind', error: info.error };
    const procs = (info.value?.processInfo ?? []) as Array<{ id: number; type: string }>;
    const rss = await rssOf(procs.map((p) => p.id));
    if (rss.size === 0) return { state: 'blind', error: 'no Chrome process answered ps' };
    const processes = procs
      .filter((p) => rss.has(p.id))
      .map((p) => ({ pid: p.id, type: p.type, rss_mb: Math.round(rss.get(p.id) as number) }))
      .sort((a, b) => b.rss_mb - a.rss_mb);
    return { state: 'sampled', rss_mb: processes.reduce((n, p) => n + p.rss_mb, 0), processes };
  } catch (err) {
    return { state: 'blind', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sampleMemory(port: number, budget: Budget, now = Date.now()): Promise<MemorySample> {
  let open: OpenPage[];
  try {
    open = await getJson<OpenPage[]>(`http://127.0.0.1:${port}/json/list`);
  } catch (err) {
    return { at: now, state: 'blind', error: `Chrome on port ${port} did not answer: ${err instanceof Error ? err.message : String(err)}`, pages: 0, tabs: [], chrome: { state: 'blind' } };
  }
  const pages = open.filter(isCountable);
  const [tabs, chrome] = await Promise.all([
    pool(pages, 8, async (p): Promise<TabMemory> => {
      if (!p.webSocketDebuggerUrl) return { id: p.id, url: p.url, title: p.title, state: 'blind', error: 'another DevTools client holds this tab' };
      const r = await cdpCall(p.webSocketDebuggerUrl, 'Runtime.getHeapUsage', {}, budget.cdp_timeout_ms);
      if (r.ok) return { id: p.id, url: p.url, title: p.title, state: 'sampled', heap_mb: Math.round((Number(r.value?.usedSize ?? 0) / MB) * 10) / 10 };
      return { id: p.id, url: p.url, title: p.title, state: r.frozen ? 'frozen' : 'blind', error: r.error };
    }),
    sampleChrome(port, budget.cdp_timeout_ms),
  ]);
  tabs.sort((a, b) => (b.heap_mb ?? -1) - (a.heap_mb ?? -1));
  return { at: now, state: 'sampled', pages: pages.length, tabs, chrome };
}

export interface MemoryAction {
  id: string;
  url: string;
  kind: MemoryEvent['kind'];
  action: 'reload' | 'close' | 'none';
  heap_mb?: number;
  chrome_mb?: number;
  reason: string;
}

export function decideMemory(sample: MemorySample, budget: Budget, reloaded: Record<string, number>, now: number): MemoryAction[] {
  if (!budget.enabled || sample.state !== 'sampled') return [];
  const verb = (id: string): 'reload' | 'close' => (budget.over === 'close' || now - (reloaded[id] ?? -Infinity) < REPEAT_MS ? 'close' : 'reload');
  const out: MemoryAction[] = [];
  for (const t of sample.tabs) {
    if ((t.heap_mb ?? 0) > budget.tab_memory_mb) {
      const action = verb(t.id);
      out.push({ id: t.id, url: t.url, kind: 'tab-over', action, heap_mb: t.heap_mb, reason: `JS heap ${t.heap_mb} MB over the per-tab budget of ${budget.tab_memory_mb} MB${action === 'close' && budget.over !== 'close' ? ', and it was reloaded in the last 30 min' : ''}` });
    }
  }
  const total = sample.chrome.rss_mb;
  if (out.length === 0 && total !== undefined && total > budget.chrome_memory_mb) {
    const biggest = sample.tabs.find((t) => t.heap_mb !== undefined);
    if (biggest) {
      const action = verb(biggest.id);
      out.push({ id: biggest.id, url: biggest.url, kind: 'chrome-over', action, heap_mb: biggest.heap_mb, chrome_mb: total, reason: `Chrome resident ${total} MB over the budget of ${budget.chrome_memory_mb} MB; largest heap is this tab (${biggest.heap_mb} MB)` });
    } else {
      out.push({ id: '', url: '', kind: 'chrome-over', action: 'none', chrome_mb: total, reason: `Chrome resident ${total} MB over the budget of ${budget.chrome_memory_mb} MB and no tab answered a heap sample; close tabs by hand (site_memory lists them)` });
    }
  }
  return out;
}

export async function closeTarget(port: number, id: string): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`close ${id}: HTTP ${r.status}`);
}

export async function enforceMemory(port: number, budget: Budget, now = Date.now(), force = false): Promise<{ sample: MemorySample | null; events: MemoryEvent[] }> {
  const book = readMemoryBook();
  if (!budget.enabled || (!force && now - book.last_sample_at < budget.sample_seconds * 1000)) return { sample: null, events: [] };
  const sample = await sampleMemory(port, budget, now);
  book.last_sample_at = now;
  const events: MemoryEvent[] = [];
  const open = new Map<string, string | undefined>();
  if (sample.state === 'sampled') {
    try {
      for (const p of await getJson<OpenPage[]>(`http://127.0.0.1:${port}/json/list`)) open.set(p.id, p.webSocketDebuggerUrl);
    } catch {
      /* the sample already holds what we need */
    }
  }
  for (const a of decideMemory(sample, budget, book.reloaded, now)) {
    const ev: MemoryEvent = { at: now, kind: a.kind, id: a.id, url: a.url, heap_mb: a.heap_mb, chrome_mb: a.chrome_mb, action: 'none', reason: a.reason };
    try {
      if (a.action === 'reload') {
        const ws = open.get(a.id);
        const r = ws ? await cdpCall(ws, 'Page.reload', {}, budget.cdp_timeout_ms) : { ok: false as const, frozen: false, error: 'no DevTools socket' };
        if (r.ok) {
          ev.action = 'reloaded';
          book.reloaded[a.id] = now;
        } else {
          await closeTarget(port, a.id);
          ev.action = 'closed';
          ev.reason += `; reload failed (${r.error}), so it was closed`;
        }
      } else if (a.action === 'close') {
        await closeTarget(port, a.id);
        ev.action = 'closed';
      }
    } catch (err) {
      ev.error = err instanceof Error ? err.message : String(err);
    }
    events.push(ev);
  }
  for (const id of Object.keys(book.reloaded)) if (now - book.reloaded[id] > REPEAT_MS) delete book.reloaded[id];
  book.events.push(...events);
  writeMemoryBook(book);
  return { sample, events };
}
