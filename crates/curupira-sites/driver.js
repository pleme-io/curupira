// roji web-terminal driver — the EMITTED payload, not the authoring surface.
//
// OWNERSHIP: the typed roji driver (Rust, chromiumoxide — the
// `Browser::connect(ws_url)` → `Page::evaluate()` pattern) owns this protocol as
// typed code and RENDERS this JS to inject over CDP. This file is that render's
// GOLDEN SPEC / reference — byte-checked against the Rust const, never
// hand-re-derived. It is JS only because CDP `Runtime.evaluate` accepts
// JavaScript into the page VM by protocol definition (a world-fact about the
// transport, not a language choice); the same way pangea emits Terraform JSON
// and a query builder emits SQL, the Rust driver emits this.
//
// Transport reality: the browser is the root of trust. Auth is the target
// application's own httpOnly, session-scoped cookie plus a query-param bearer —
// both short-lived and browser-held. Driving the browser's OWN socket over CDP
// needs none of them replayed. A native WS client (Rust `tokio-tungstenite`, no
// browser) would have to harvest and replay them and is the tier above, gated on
// a reachability proof, not assumed. When proven, the same Rust verbs keep; only
// the transport swaps and this emission is dropped.
//
// SITE-SPECIFIC BITS ARE INJECTED, NOT BAKED. roji sets `window.__ROJI.driver`
// before installing this payload: `readyBanner` (a regex the first frames must
// match before connect resolves — omit to resolve as soon as the socket opens),
// `connectButton` (a regex matched case-insensitively against button text) and
// `heartbeatMs` (the resize-frame cadence that defeats the backend's idle close).
// Absent config, generic defaults apply, so `roji emit-driver` prints a payload
// that runs standalone.
//
// Every call returns JSON so the caller never parses a screen. Keep
// dependency-free and versioned — extend, and bump DRIVER_VERSION in lockstep
// with the Rust const.

(() => {
  const DRIVER_VERSION = '0.1.0';
  if (window.WT && window.WT.version === DRIVER_VERSION) return 'WT already ' + DRIVER_VERSION;

  const CFG = (window.__ROJI && window.__ROJI.driver) || {};
  const READY = CFG.readyBanner ? new RegExp(CFG.readyBanner) : null;
  const CONNECT_BTN = new RegExp(CFG.connectButton || 'Connect', 'i');
  const HEARTBEAT_MS = CFG.heartbeatMs || 8000;

  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const nonce = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);

  const WT = {
    version: DRIVER_VERSION,
    sock: null,
    hb: null,

    // Hook WebSocket so the next-created socket is captured and its binary
    // output is decoded into WT._out. Call BEFORE clicking Connect.
    _hook() {
      const OW = window.__WT_OW || window.WebSocket;
      window.__WT_OW = OW;
      const self = this;
      function W(url, protocols) {
        const s = protocols === undefined ? new OW(url) : new OW(url, protocols);
        self.sock = s; self._out = ''; self._url = String(url);
        s.addEventListener('message', async (e) => {
          let d = e.data;
          if (typeof d === 'string') { self._out += d; return; }
          try { const b = d.arrayBuffer ? await d.arrayBuffer() : d;
                self._out += new TextDecoder().decode(new Uint8Array(b)); } catch (err) {}
        });
        return s;
      }
      W.prototype = OW.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k, i) => W[k] = i);
      window.WebSocket = W;
      return 'hooked';
    },

    // Click the terminal panel's connect button (matched by the injected regex).
    _clickConnect() {
      const b = Array.from(document.querySelectorAll('button')).find(e => CONNECT_BTN.test((e.textContent || '').trim()));
      if (!b) return false;
      b.click(); return true;
    },

    // Start the resize heartbeat that defeats the backend's idle close.
    _startHeartbeat() {
      if (this.hb) clearInterval(this.hb);
      const self = this;
      this.hb = setInterval(() => { try {
        if (self.sock && self.sock.readyState === 1) self.sock.send(JSON.stringify({ type: 'resize', cols: 120, rows: 32 }));
      } catch (e) {} }, HEARTBEAT_MS);
    },

    alive() { return !!(this.sock && this.sock.readyState === 1); },

    // Connect (or reconnect). Resolves when the socket is open and, if a ready
    // banner is configured, it has arrived — otherwise as soon as the socket is
    // open. Rejects on timeout. Idempotent-safe to call again if dead.
    async connect(timeoutMs) {
      timeoutMs = timeoutMs || 15000;
      this._hook();
      if (!this._clickConnect()) throw new Error('no Connect button — is the Terminal tab open?');
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 200));
        if (this.alive() && (!READY || READY.test(this._out || ''))) { this._startHeartbeat(); return { connected: true, waitedMs: Date.now() - t0 }; }
      }
      throw new Error('connect timeout after ' + timeoutMs + 'ms (rs=' + (this.sock && this.sock.readyState) + ')');
    },

    // Run one command with DETERMINISTIC read-back: a per-call sentinel prints
    // AFTER the command with its exit code, so the read never depends on a fixed
    // sleep. Returns { exit, out } with the echoed input, prompt and sentinel
    // stripped. `cmd` may contain newlines (heredocs are fine).
    async run(cmd, opts) {
      opts = opts || {};
      const timeoutMs = opts.timeoutMs || 20000;
      const pollMs = opts.pollMs || 200;
      if (!this.alive()) throw new Error('__DEAD__ rs=' + (this.sock && this.sock.readyState) + ' — call WT.connect() first');
      const n = nonce();
      const marker = '__WT_' + n + '__';
      // marker held in a var so the literal "<marker> <digit>" never appears in the echo
      const payload = 'm=' + marker + '; ' + cmd + '; printf "\\n%s %d\\n" "$m" "$?"\n';
      this._out = '';
      this.sock.send(JSON.stringify({ type: 'input', data: payload }));
      const re = new RegExp('\\n' + marker + ' (\\d+)\\r?\\n');
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, pollMs));
        const mm = (this._out || '').match(re);
        if (mm) {
          const exit = parseInt(mm[1], 10);
          let out = this._out.slice(0, mm.index);
          // drop the first line (the echoed command) and normalise
          out = stripAnsi(out).replace(/\r/g, '');
          const lines = out.split('\n');
          if (lines.length && lines[0].indexOf(marker) >= 0) lines.shift(); // echoed input line
          out = lines.join('\n').replace(/\n?[^\n]*[#$]\s*$/, '').replace(/^\n+/, '');
          return { exit, out };
        }
        if (!this.alive()) throw new Error('__DEAD__ mid-run rs=' + (this.sock && this.sock.readyState));
      }
      throw new Error('run timeout after ' + timeoutMs + 'ms; tail=' + stripAnsi(this._out || '').slice(-200));
    },

    // Reconnect-and-retry — a FIRST-CLASS invariant, not a nicety. The terminal
    // backend drops sessions (1006) and, when the workloads churn under the
    // cluster autoscaler, can drop them within seconds of connecting. A single
    // fixed heartbeat cannot beat that; retry-with-backoff can. All verbs route
    // through this. A non-transport error (a real kubectl failure) is NOT retried.
    async runR(cmd, opts) {
      opts = opts || {}; const tries = opts.tries || 4;
      let backoff = opts.backoffMs || 800;
      for (let i = 0; i < tries; i++) {
        try { if (!this.alive()) await this.connect(18000); return await this.run(cmd, opts); }
        catch (e) {
          const m = String(e.message);
          if (m.indexOf('__DEAD__') < 0 && m.indexOf('timeout') < 0 && m.indexOf('connect timeout') < 0) throw e;
          this.sock = null; await new Promise(r => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 8000);
        }
      }
      throw new Error('runR exhausted ' + tries + ' tries — terminal backend is dropping sessions (check workload/autoscaler churn)');
    },

    // kubectl get <resource> -o yaml, returned as a string (throws on non-zero).
    async getYaml(ns, resource, opts) {
      const r = await this.runR('kubectl -n ' + ns + ' get ' + resource + ' -o yaml', opts);
      if (r.exit !== 0) throw new Error('get failed exit=' + r.exit + ': ' + r.out.slice(-300));
      return r.out;
    },

    // kubectl apply -f - of a full manifest via heredoc, then read the applied
    // object back so the return is proof, not a request. Returns { apply, readback }.
    async apply(ns, yaml, opts) {
      const cmd = 'kubectl -n ' + ns + " apply -f - <<'WTEOF'\n" + yaml.replace(/\s+$/, '') + '\nWTEOF';
      const apply = await this.runR(cmd, opts);
      return { exit: apply.exit, out: apply.out };
    },

    // kubectl patch, typed shapes. patch = a JS object or a JSON string.
    async patch(ns, resource, patch, type, opts) {
      type = type || 'strategic';
      const body = typeof patch === 'string' ? patch : JSON.stringify(patch);
      const cmd = 'kubectl -n ' + ns + ' patch ' + resource + ' --type=' + type + " -p '" + body.replace(/'/g, "'\\''") + "'";
      return this.runR(cmd, opts);
    },
  };

  window.WT = WT;
  return 'WT ' + DRIVER_VERSION + ' installed';
})()
