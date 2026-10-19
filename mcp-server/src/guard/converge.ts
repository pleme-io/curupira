import { cdpCall, getJson } from './cdp.js';
import { closeTarget, sampleChrome } from './memory.js';
import {
  compileRoutes,
  planTabs,
  readLedger,
  recordOpen,
  writeLedger,
  type Budget,
  type DesiredTab,
  type GuardSite,
  type OpenPage,
  type TabPlan,
} from './tabs.js';

export interface ConvergeReport {
  plan: TabPlan;
  opened: string[];
  deduped: Array<{ id: string; url: string; why: string }>;
  memoryOver?: { chrome_mb: number; budget_mb: number };
  errors: string[];
}

export interface ConvergeInput {
  port: number;
  desired: DesiredTab[];
  sites: GuardSite[];
  budget: Budget;
  open: OpenPage[];
  enforce: boolean;
  now?: number;
}

export async function converge(input: ConvergeInput): Promise<ConvergeReport> {
  const now = input.now ?? Date.now();
  const ledger = readLedger();
  const routes = compileRoutes(input.sites);
  const plan = planTabs({ desired: input.desired, open: input.open, ledger, routes, budget: input.budget, now, closeDuplicates: input.enforce });
  const report: ConvergeReport = { plan, opened: [], deduped: [], errors: [] };
  if (!input.enforce) {
    writeLedger(ledger);
    return report;
  }
  for (const c of plan.close) {
    try {
      await closeTarget(input.port, c.id);
      report.deduped.push(c);
    } catch (err) {
      report.errors.push(`close ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (plan.open.length > 0 && input.budget.enabled) {
    const chrome = await sampleChrome(input.port, input.budget.cdp_timeout_ms);
    if (chrome.state === 'sampled' && (chrome.rss_mb ?? 0) > input.budget.chrome_memory_mb) {
      report.memoryOver = { chrome_mb: chrome.rss_mb as number, budget_mb: input.budget.chrome_memory_mb };
      plan.overBudget.push(...plan.open.map((t) => t.key));
      plan.open = [];
    }
  }
  if (plan.open.length > 0) {
    let browserWs: string | undefined;
    try {
      browserWs = (await getJson<{ webSocketDebuggerUrl: string }>(`http://127.0.0.1:${input.port}/json/version`)).webSocketDebuggerUrl;
    } catch (err) {
      report.errors.push(`Chrome on port ${input.port} did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const t of browserWs ? plan.open : []) {
      const r = await cdpCall(browserWs as string, 'Target.createTarget', { url: t.url, background: true }, 10_000);
      if (r.ok) {
        recordOpen(ledger, String(r.value?.targetId ?? ''), t, t.tabKey, now);
        report.opened.push(t.key);
      } else {
        report.errors.push(`open ${t.key}: ${r.error}`);
      }
    }
  }
  writeLedger(ledger);
  return report;
}
