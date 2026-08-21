// Terminal session supervisor.
//
// The payload in driver.js gives you ONE connection and a per-call retry. This
// keeps a session alive indefinitely, in the background, without a caller
// driving it: it owns the socket, heartbeats against the idle close, and
// re-clicks Connect whenever the backend drops one.
//
// Why it exists, measured:
//
//   - The socket closes ~13s after the last frame (code 1006, wasClean:false).
//     Traffic defeats it; nothing else does.
//   - The backend also drops sessions seconds after the banner during host-side
//     churn, which no heartbeat can prevent — only reconnecting can.
//   - Hooking window.WebSocket captures only sockets created AFTER injection.
//     If the operator already clicked Connect by hand, the hook sees nothing and
//     a naive connect() waits for a banner that already arrived and times out
//     while the session is perfectly usable. Measured 2026-08-21: exactly that.
//     So install FORCES a fresh socket through the hook rather than trying to
//     adopt one it cannot reference.
//
// It is a supervisor, not a policy: it never types a command and never clicks
// anything except the terminal's own Connect/Disconnect controls.
(() => {
  const VERSION = '0.2.0';
  if (window.WTS && window.WTS.version === VERSION) return 'WTS already ' + VERSION;

  const CFG = (window.__CURUPIRA_SITES && window.__CURUPIRA_SITES.driver) || {};
  const READY = CFG.readyBanner || '';
  const CONNECT = CFG.connectButton || 'Connect';
  const HEARTBEAT_MS = CFG.heartbeatMs || 8000;

  const btn = (re) => Array.from(document.querySelectorAll('button,[role="button"]'))
    .find(e => re.test((e.textContent || '').replace(/\s+/g, ' ').trim()));

  const WTS = {
    version: VERSION,
    sock: null,
    out: '',
    // Counters, not booleans: "it reconnected 40 times in an hour" is a finding
    // about the backend, and a boolean would hide it.
    stats: { connects: 0, drops: 0, heartbeats: 0, escalations: 0, consecutiveFailures: 0, lastCloseCode: null, lastDropAt: null, startedAt: Date.now() },
    running: false,
    _hb: null,
    _loop: null,

    _hook() {
      const OW = window.__WTS_OW || window.WebSocket;
      window.__WTS_OW = OW;
      const self = this;
      function W(url, protocols) {
        const s = protocols === undefined ? new OW(url) : new OW(url, protocols);
        // Only adopt the terminal's own socket; a page may open others.
        if (/\/terminal\//.test(String(url)) || /\/ws\b/.test(String(url))) {
          self.sock = s;
          self.out = '';
          // Reset per-socket: the banner is a fact about THIS connection.
          self.bannerSeen = false;
          self.stats.connects++;
          s.addEventListener('message', async (e) => {
            let d = e.data;
            if (typeof d === 'string') { self.out += d; self._noteBanner(); return; }
            try {
              const b = d.arrayBuffer ? await d.arrayBuffer() : d;
              self.out += new TextDecoder().decode(new Uint8Array(b));
              self._noteBanner();
            } catch (err) { /* a frame we cannot decode is not a reason to die */ }
          });
          s.addEventListener('close', (e) => {
            self.stats.drops++;
            self.stats.lastCloseCode = e.code;
            self.stats.lastDropAt = Date.now();
          });
        }
        return s;
      }
      W.prototype = OW.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k, i) => { W[k] = i; });
      window.WebSocket = W;
    },

    alive() { return !!(this.sock && this.sock.readyState === 1); },

    bannerSeen: false,
    // Set when a command is abandoned; cleared by a successful resync.
    dirty: false,

    // Latch the banner when it arrives. It must be a LATCH, not a scan of the
    // current buffer: `run` clears `out` before each command, so a buffer-scan
    // reported the session un-ready forever after the first command — socket
    // open, banner long since consumed, state stuck at 'open-no-banner'.
    // Measured 2026-08-21.
    _noteBanner() {
      if (!this.bannerSeen && (!READY || this.out.includes(READY))) this.bannerSeen = true;
    },

    ready() { return this.alive() && (!READY || this.bannerSeen); },

    // Connect. `forceFresh` clicks Disconnect first, and is used ONLY on the
    // initial adoption — never on a reconnect.
    //
    // That distinction is load-bearing and cost a live debugging round: clicking
    // Disconnect fires `close_tunnel` on the agent, so a supervisor that
    // disconnected before every retry tore down the whole tunnel each time and
    // had to re-establish it. Measured 2026-08-21 — sockets opened and died
    // within ~6s in a loop, which reads exactly like backend churn and was
    // actually self-inflicted. On a reconnect the tunnel is usually still up;
    // just click Connect.
    async connect(timeoutMs, forceFresh) {
      timeoutMs = timeoutMs || 25000;
      if (forceFresh && !this.alive()) {
        const d = btn(/^Disconnect$/i);
        if (d) { d.click(); await new Promise(r => setTimeout(r, 800)); }
      }
      const c = btn(new RegExp(CONNECT, 'i'));
      if (!c) return { connected: false, error: 'no Connect control on this page' };
      c.click();
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 250));
        if (this.ready()) return { connected: true, waitedMs: Date.now() - t0 };
      }
      return { connected: false, error: 'banner not seen in ' + timeoutMs + 'ms', socketOpen: this.alive() };
    },

    // The background loop. Heartbeats while alive; reconnects when not, with
    // backoff so a genuinely-down backend is not hammered.
    start(opts) {
      opts = opts || {};
      if (this.running) return 'already running';
      this._hook();
      this.running = true;
      // Recovery ESCALATES rather than picking one strategy.
      //
      // Disconnecting on every retry tears down the tunnel and makes reconnects
      // expensive (measured: sockets opening and dying in a ~6s loop). But never
      // disconnecting leaves a wedged UI unrecoverable — measured too: after two
      // drops, plain Connect clicks stopped producing a socket AT ALL (the drop
      // counter stopped moving, so nothing was even opening), and the session sat
      // in `reconnecting` for twelve minutes. One forced Disconnect-then-Connect
      // recovered it in 1.9s.
      //
      // So: plain Connect first — cheap and usually right — and escalate to a
      // forced fresh socket only after it has failed repeatedly.
      let first = true;
      let failures = 0;
      const escalateAfter = opts.escalateAfter || 3;
      let backoff = 2000;
      const maxBackoff = opts.maxBackoffMs || 30000;

      this._hb = setInterval(() => {
        try {
          if (this.alive()) {
            this.sock.send(JSON.stringify({ type: 'resize', cols: 120, rows: 32 }));
            this.stats.heartbeats++;
          }
        } catch (e) { /* the close handler will notice */ }
      }, HEARTBEAT_MS);

      const tick = async () => {
        if (!this.running) return;
        try {
          if (!this.alive()) {
            const force = first || failures >= escalateAfter;
            const r = await this.connect(20000, force);
            first = false;
            if (r.connected) {
              failures = 0;
              this.stats.escalations = this.stats.escalations || 0;
              backoff = 2000;
            } else {
              failures++;
              if (force) this.stats.escalations = (this.stats.escalations || 0) + 1;
              backoff = Math.min(backoff * 2, maxBackoff);
            }
          } else {
            backoff = 1000;
          }
        } catch (e) { backoff = Math.min(backoff * 2, maxBackoff); }
        // Poll less often when healthy: every tick that finds a live socket is
        // pure overhead, and the heartbeat is what actually holds it open.
        this._loop = setTimeout(tick, this.alive() ? 5000 : backoff);
      };
      tick();
      return 'supervising';
    },

    stop() {
      this.running = false;
      if (this._hb) clearInterval(this._hb);
      if (this._loop) clearTimeout(this._loop);
      return 'stopped';
    },

    // Wait until the supervisor has a ready session. Callers use this instead of
    // managing connections themselves.
    async awaitReady(timeoutMs) {
      const t0 = Date.now();
      while (Date.now() - t0 < (timeoutMs || 60000)) {
        if (this.ready()) return true;
        await new Promise(r => setTimeout(r, 250));
      }
      return false;
    },

    // Send a command on the SUPERVISED socket and read its output back
    // deterministically.
    //
    // This exists because the driver's own runR manages its own connection —
    // it clicks Connect and hooks the socket — and running both means two
    // managers fighting over one session. Measured 2026-08-21: with the
    // supervisor running, runR exhausted its retries while the supervisor was
    // mid-reconnect, each undoing the other. So connection ownership lives in
    // exactly one place, here, and commands only send.
    //
    // The read is a per-call sentinel: a nonce plus `$?` printed AFTER the
    // command, so output is delimited without a fixed sleep and the exit code
    // arrives with the bytes.
    async run(cmd, opts) {
      opts = opts || {};
      const timeoutMs = opts.timeoutMs || 45000;
      if (!(await this.awaitReady(opts.readyTimeoutMs || 60000))) {
        return { ok: false, error: 'no ready session', status: this.status() };
      }
      // A previous command was abandoned and may still be emitting. Get back to
      // a known state before reading anything new.
      if (this.dirty) {
        const r = await this.resync();
        if (!r.ok) return { ok: false, error: 'session dirty: ' + r.error, status: this.status() };
      }
      const n = Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
      const marker = '__WTS_' + n + '__';
      const payload = 'm=' + marker + '; ' + cmd + '; printf "\\n%s %d\\n" "$m" "$?"\n';
      this.out = '';
      try {
        this.sock.send(JSON.stringify({ type: 'input', data: payload }));
      } catch (e) {
        return { ok: false, error: 'send failed: ' + e.message, status: this.status() };
      }
      const re = new RegExp('\\n' + marker + ' (\\d+)\\r?\\n');
      const t0 = Date.now();
      // Deadline is based on PROGRESS, not just elapsed time.
      //
      // Measured 2026-08-21: grepping an 88MB binary five times ran well past a
      // fixed timeout while the shell was healthily working — output was still
      // arriving. Failing there reports "timeout" for a command that is simply
      // slow, and, worse, its output lands later and corrupts the NEXT command's
      // sentinel scan. So a command that is still producing output gets more
      // time, bounded by an absolute cap.
      const idleMs = opts.idleMs || 20000;
      const hardCapMs = opts.hardCapMs || 300000;
      let lastLen = 0;
      let lastGrowth = Date.now();
      while (Date.now() - t0 < hardCapMs) {
        await new Promise(r => setTimeout(r, 150));
        const cur = (this.out || '').length;
        if (cur !== lastLen) { lastLen = cur; lastGrowth = Date.now(); }
        // Give up only when the command has been SILENT for idleMs and the
        // nominal budget is spent — silence plus elapsed, never elapsed alone.
        if (Date.now() - t0 > timeoutMs && Date.now() - lastGrowth > idleMs) {
          this.dirty = true;
          return {
            ok: false,
            error: 'no output for ' + idleMs + 'ms after ' + Math.round((Date.now()-t0)/1000) + 's',
            partial: (this.out || '').slice(-400),
          };
        }
        const mm = (this.out || '').match(re);
        if (mm) {
          let out = this.out.slice(0, mm.index);
          out = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
          const lines = out.split('\n');
          if (lines.length && lines[0].indexOf(marker) >= 0) lines.shift();
          out = lines.join('\n').replace(/\n?[^\n]*[#$]\s*$/, '').replace(/^\n+/, '');
          return { ok: true, exit: parseInt(mm[1], 10), out };
        }
        // A drop mid-command is the supervisor's problem, not a failure to
        // report here — it will reconnect; say so plainly instead of hanging.
        if (!this.alive()) {
          return { ok: false, error: 'session dropped mid-command; supervisor is reconnecting', status: this.status() };
        }
      }
      this.dirty = true;
      return { ok: false, error: 'hard cap ' + hardCapMs + 'ms exceeded', tail: (this.out || '').slice(-300) };
    },

    // Bring a session back to a known state after a command was abandoned.
    //
    // An abandoned command keeps producing output, and that output arrives while
    // the NEXT command is being read — so its sentinel scan can match stale text
    // or miss entirely. Nothing detects that; the result is simply wrong. So a
    // run that gives up marks the session `dirty`, and the next one resyncs
    // first: interrupt, then round-trip a fresh marker until the reply is the
    // marker and nothing else.
    async resync(timeoutMs) {
      timeoutMs = timeoutMs || 20000;
      if (!this.alive()) return { ok: false, error: 'no session to resync' };
      try { this.sock.send(JSON.stringify({ type: 'input', data: '\u0003' })); } catch (e) { /* interrupt is best-effort */ }
      await new Promise(r => setTimeout(r, 400));
      const tag = '__WTS_SYNC_' + Math.random().toString(16).slice(2, 10) + '__';
      this.out = '';
      try { this.sock.send(JSON.stringify({ type: 'input', data: 'echo ' + tag + '\n' })); }
      catch (e) { return { ok: false, error: 'resync send failed: ' + e.message }; }
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 150));
        // Two occurrences: the echoed command and its output. Waiting for the
        // second is what proves the shell has caught up with us.
        if ((this.out.match(new RegExp(tag, 'g')) || []).length >= 2) {
          this.out = '';
          this.dirty = false;
          return { ok: true, waitedMs: Date.now() - t0 };
        }
      }
      this.dirty = true;
      return { ok: false, error: 'resync timed out; session is still producing stale output' };
    },

    // What a caller should poll instead of guessing. Says which of the states
    // holds, rather than a bare boolean that cannot distinguish "never started"
    // from "dropped and retrying".
    status() {
      const s = this.sock ? this.sock.readyState : null;
      return {
        supervising: this.running,
        dirty: this.dirty,
        state: !this.running ? 'stopped'
          : this.ready() ? 'ready'
            : this.alive() ? 'open-no-banner'
              : 'reconnecting',
        socketReadyState: s,
        uptimeMs: Date.now() - this.stats.startedAt,
        ...this.stats,
      };
    },
  };

  window.WTS = WTS;
  return 'WTS ' + VERSION + ' installed';
})();
