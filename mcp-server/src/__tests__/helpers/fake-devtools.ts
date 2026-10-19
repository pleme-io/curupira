import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export interface FakeTarget {
  id: string;
  type: string;
  url: string;
  heapMb?: number;
  frozen?: boolean;
  reloads?: number;
}

export interface FakeDevtools {
  port: number;
  targets: FakeTarget[];
  created: string[];
  closed: string[];
  close: () => Promise<void>;
}

export async function fakeDevtools(land: (url: string) => string = (u) => u, browserPid = 1): Promise<FakeDevtools> {
  const state: FakeDevtools = { port: 0, targets: [], created: [], closed: [], close: async () => {} };
  let seq = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (v: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(v));
    };
    if (url === '/json/version') return send({ webSocketDebuggerUrl: `ws://127.0.0.1:${state.port}/devtools/browser/b` });
    if (url === '/json/list' || url === '/json') {
      return send(state.targets.map((t) => ({ id: t.id, type: t.type, url: t.url, title: t.url, webSocketDebuggerUrl: `ws://127.0.0.1:${state.port}/devtools/page/${t.id}` })));
    }
    const closing = /^\/json\/close\/(.+)$/.exec(url);
    if (closing) {
      state.closed.push(closing[1]);
      state.targets = state.targets.filter((t) => t.id !== closing[1]);
      return send('Target is closing');
    }
    if (url.startsWith('/json/activate/')) return send('Target activated');
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const page = /\/devtools\/page\/(.+)$/.exec(req.url ?? '')?.[1];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: { url?: string } };
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
      const target = state.targets.find((t) => t.id === page);
      if (target?.frozen) return;
      switch (msg.method) {
        case 'Target.createTarget': {
          const id = `T${++seq}`;
          state.created.push(msg.params?.url ?? '');
          state.targets.push({ id, type: 'page', url: land(msg.params?.url ?? '') });
          return reply({ targetId: id });
        }
        case 'SystemInfo.getProcessInfo':
          return reply({ processInfo: [{ type: 'browser', id: browserPid, cpuTime: 0 }] });
        case 'Runtime.getHeapUsage':
          return reply({ usedSize: (target?.heapMb ?? 10) * 1024 * 1024, totalSize: 0 });
        case 'Page.reload':
          if (target) {
            target.reloads = (target.reloads ?? 0) + 1;
            target.heapMb = 10;
          }
          return reply({});
        default:
          return reply({});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => r());
    });
  return state;
}
