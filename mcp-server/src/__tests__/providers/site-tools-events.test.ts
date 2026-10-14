import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Container } from '../../core/di/container.js';
import { createTestContainer, resetTestContainer } from '../test-container.js';
import { SiteToolProviderFactory } from '../../mcp/tools/providers/site-tools.factory.js';
import { LoggerToken, ValidatorToken } from '../../core/di/tokens.js';

const SITE = {
  id: 'chat',
  target: 'browser',
  base_url: 'https://chat.example.invalid',
  match: ['chat.example.invalid'],
  tools: [
    {
      name: 'chat_channel_act_send',
      description: 'MUTATES the host: posts a message',
      kind: 'act',
      page: 'channel',
      json_schema: { type: 'object', properties: {}, required: ['authorized_by', 'value'], additionalProperties: false },
      js: 'FOCUS',
      effect: 'mutate',
      describes: 'posts a message as the operator',
      input: { submit: 'enter' },
    },
  ],
  events: [{ page: 'channel', name: 'messages', install_js: 'INSTALL', drain_js: 'DRAIN' }],
  launch: { app: '/nonexistent/Chat.app', port: 1 },
};

function writeBundle(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curupira-ev-'));
  const p = path.join(dir, 'sites.bundle.json');
  fs.writeFileSync(p, JSON.stringify({ schema_version: 2, sites: [SITE] }));
  return p;
}

function fakeClient(answers: Record<string, unknown>) {
  const sent: Array<{ method: string; params: any }> = [];
  return {
    sent,
    send: async (method: string, params: any) => {
      sent.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const e = params.expression as string;
        if (e === 'window.location.href') return { result: { value: 'https://chat.example.invalid/c/1' } };
        return { result: { value: answers[e] ?? null } };
      }
      return {};
    },
  };
}

const exec = (provider: any, tool: string, args: Record<string, unknown>) => provider.getHandler(tool)!.execute(args) as Promise<any>;

describe('typing actions, event streams, app launch', () => {
  let container: Container;
  beforeEach(() => {
    container = createTestContainer();
    process.env.CURUPIRA_SITES_SOURCE = 'bundle';
  });
  afterEach(() => {
    resetTestContainer(container);
    delete process.env.CURUPIRA_SITES_SOURCE;
  });

  const make = (client: unknown) =>
    new SiteToolProviderFactory().create({
      chromeService: { getCurrentClient: () => client, connect: async () => client },
      logger: container.resolve(LoggerToken),
      validator: container.resolve(ValidatorToken),
      siteBundlePath: writeBundle(),
    } as any);

  it('refuses to type without a grant, before touching the page', async () => {
    const c = fakeClient({ FOCUS: true });
    const res = await exec(make(c), 'site_act', { site: 'chat', page: 'channel', control: 'send', value: 'hi' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/MUTATES/);
    expect(c.sent).toEqual([]);
  });

  it('focuses, inserts trusted text, then presses Enter', async () => {
    const c = fakeClient({ FOCUS: true });
    const res = await exec(make(c), 'site_act', { site: 'chat', page: 'channel', control: 'send', value: 'on it', authorized_by: 'yes send it' });
    expect(res.success).toBe(true);
    const methods = c.sent.map((s) => s.method);
    expect(methods).toEqual(['Runtime.evaluate', 'Runtime.evaluate', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(c.sent[2]!.params).toEqual({ text: 'on it' });
    expect(c.sent[3]!.params.key).toBe('Enter');
  });

  it('reports a missing text box instead of typing into whatever has focus', async () => {
    const c = fakeClient({ FOCUS: false });
    const res = await exec(make(c), 'site_act', { site: 'chat', page: 'channel', control: 'send', value: 'x', authorized_by: 'ok' });
    expect(res.success).toBe(false);
    expect(c.sent.some((s) => s.method === 'Input.insertText')).toBe(false);
  });

  it('watches and drains a stream, and says when the container is absent', async () => {
    const ok = fakeClient({ INSTALL: { installed: true, already: false, within: true }, DRAIN: { watching: true, events: [{ at: 1, text: 'ALERT x' }], dropped: 0 } });
    const p = make(ok);
    expect((await exec(p, 'site_watch', { site: 'chat', stream: 'messages' })).success).toBe(true);
    const ev = await exec(p, 'site_events', { site: 'chat' });
    expect(ev.data.streams.messages.events[0].text).toBe('ALERT x');

    const missing = fakeClient({ INSTALL: { installed: false, already: false, within: false } });
    const r = await exec(make(missing), 'site_watch', { site: 'chat', stream: 'messages' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not on this page/);
  });

  it('says plainly when an app never opens its DevTools port', async () => {
    const res = await exec(make(fakeClient({})), 'site_app_launch', { site: 'chat' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/did not open DevTools on port 1/);
  }, 40000);
});
