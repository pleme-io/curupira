export type CdpAnswer = { ok: true; value: any } | { ok: false; frozen: boolean; error: string };

export async function cdpCall(wsUrl: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 4000): Promise<CdpAnswer> {
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    return { ok: false, frozen: false, error: err instanceof Error ? err.message : String(err) };
  }
  return await new Promise<CdpAnswer>((resolve) => {
    let done = false;
    const finish = (a: CdpAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(a);
    };
    const timer = setTimeout(() => finish({ ok: false, frozen: true, error: `${method} got no answer within ${timeoutMs} ms` }), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => finish({ ok: false, frozen: false, error: `cannot open ${wsUrl}` });
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id !== 1) return;
      finish(d.error ? { ok: false, frozen: false, error: d.error.message } : { ok: true, value: d.result });
    };
  });
}

export async function getJson<T>(url: string, timeoutMs = 3000, method = 'GET'): Promise<T> {
  const r = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
