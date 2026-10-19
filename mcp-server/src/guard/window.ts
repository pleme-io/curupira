export type TimeWindow =
  | { kind: 'relative'; param: string; default?: string; max?: string }
  | { kind: 'epoch-ms'; from: string; to: string; knob?: string; default?: string; max?: string };

export interface Bounded {
  substitute: Record<string, string>;
  append: Record<string, string>;
}

const LEGAL = 'a bounded relative span: -<n><s|m|h|d|w>, optionally snapped (@h, @d), e.g. -15m, -24h, -7d@d';
const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

export function knobOf(w: TimeWindow): string {
  return w.kind === 'relative' ? w.param : (w.knob ?? 'window');
}

export function spanSeconds(spec: string, allowSnap: boolean): number | string {
  const refuse = (why: string) => `time window '${spec}' ${why}; legal: ${LEGAL}`;
  if (!spec.startsWith('-')) return refuse('is not a relative span back from now');
  const body = spec.slice(1);
  const at = body.indexOf('@');
  const span = at < 0 ? body : body.slice(0, at);
  const snap = at < 0 ? undefined : body.slice(at + 1);
  if (snap !== undefined) {
    if (!allowSnap) return refuse('snaps, which this site cannot express');
    if (!/^[A-Za-z0-9]+$/.test(snap)) return refuse('has a malformed snap');
  }
  const m = /^(\d+)([smhdw])$/.exec(span);
  if (!m) return refuse(span === '' ? 'is empty' : 'has no count or an unknown unit');
  const n = Number(m[1]);
  if (n === 0) return refuse('is empty');
  return n * UNIT[m[2]];
}

export function boundWindow(w: TimeWindow, given: string | undefined, nowMs: number): Bounded | { refused: string } {
  const max = w.max ?? '-30d';
  const spec = given ?? w.default ?? '-24h';
  const secs = spanSeconds(spec, w.kind === 'relative');
  if (typeof secs === 'string') return { refused: secs };
  const cap = spanSeconds(max, false);
  if (typeof cap === 'string') return { refused: cap };
  if (secs > cap) return { refused: `time window '${spec}' is wider than this page's max '${max}'` };
  if (w.kind === 'relative') return { substitute: { [w.param]: spec }, append: {} };
  return { substitute: {}, append: { [w.from]: String(Math.max(0, nowMs - secs * 1000)), [w.to]: String(nowMs) } };
}

export function applyBounded(url: string, b: Bounded): string {
  let out = url;
  for (const [k, v] of Object.entries(b.substitute)) out = out.split(`{${k}}`).join(encodeURIComponent(v));
  for (const [k, v] of Object.entries(b.append)) out = `${out}${out.includes('?') ? '&' : '?'}${k}=${v}`;
  return out;
}
