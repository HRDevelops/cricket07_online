// Netplay transport, shared by the page (loader.js) and the headless Node harness (node_env.js).
//
// Connects to a room on the Worker (worker.js: NetplayRoom), shows the lobby through callbacks, and once the
// host starts the session moves lockstep messages between this peer's game (host/netplay.c) and the room:
// it drains the game's outbox (our pad inputs, state hashes) into the socket and feeds what other peers
// send into the game. Plain script: the page loads it with <script>, Node with require().
(function (root) {
  'use strict';


  // Room client. opts: { url (ws(s)://.../netplay/<CODE>?ticket=...), name, version, iceServers (STUN/TURN
  // for the direct channels, from the ticket), relayOnly (direct channels only through TURN), testLoss (tests:
  // drop this fraction of direct packets on arrival), onLobby(lobby),
  // onStart(session), onLeft(slot), onError(message), onClose(), reconnectUrl() (async: a fresh url with a
  // new ticket), onReconnect(state) }. If the room connection drops during a game it reconnects, rejoins
  // its slot and resends its recent inputs (the others wait in lockstep meanwhile).
  //
  // Inputs go through the room (a relay every peer can reach) and, where WebRTC is available, also over a
  // direct data channel to each peer, set up through the room in the lobby. The game stores each frame's
  // input idempotently, so duplicates are harmless and the faster path wins. The direct channels don't
  // retransmit (a resend would come long after the room's copy); instead every packet also repeats our last
  // few inputs, so a lost one is covered by the next, a frame later. Round trips to the room and
  // over each direct channel are measured (pings 4 times a second; the 90th percentile of the last 40, so
  // jitter counts) and reported, so the lobby can pick an input delay that covers the slowest pair of
  // players (autoDelay).

  // Round-trip samples over one path, summarised as a 90th percentile.
  function trip() {
    const samples = [];
    return {
      add(ms) { samples.push(ms); if (samples.length > 40) samples.shift(); },
      p90() {
        if (!samples.length) return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      },
    };
  }

  function connect(opts) {
    let ws = null;
    let started = false, closing = false, retries = 0, heard = Date.now();
    const history = [];       // our recent input batches, resent after a reconnect
    const HISTORY = 600;
    const recent = [];        // our last few inputs, repeated in every direct packet
    const REPEAT = 8;
    let game = null;          // the Emscripten module once attached
    let timer = null;
    let me = -1;
    const early = [];         // input batches that arrive before the game is attached
    const roomTrip = trip();
    let rtt = 0, reported = 0;   // round trip to the room (90th percentile), and the value the room last heard
    const peers = new Map();  // slot -> { pc, dc, trip, rtt }
    const p2pReported = {};
    const readySlots = new Set();
    const readyListeners = new Set();

    function markReady(slot) {
      const s = (slot !== undefined && slot >= 0) ? slot : (me >= 0 ? (1 - me) : 0);
      readySlots.add(s);
      for (const listener of readyListeners) {
        try { listener(s); } catch (_) {}
      }
    }

    function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
    const ping = setInterval(() => {
      // in a game, a room connection that has gone quiet (pongs come 4 times a second) is dead even if the
      // browser hasn't noticed yet: drop it and reconnect
      if (started && !closing && ws && ws.readyState === 1 && Date.now() - heard > 5000) abandon();
      send({ t: 'ping', ts: Date.now() });
      for (const p of peers.values()) if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      // direct round trips, for the lobby and the auto delay: sent when one moves by more than 5 ms
      const p2p = {};
      let changed = false;
      for (const [slot, p] of peers) {
        if (!p.rtt) continue;
        p2p[slot] = Math.round(p.rtt);
        if (Math.abs(p2p[slot] - (p2pReported[slot] || 0)) > 5) changed = true;
      }
      if (changed) { Object.assign(p2pReported, p2p); send({ t: 'p2p', rtt: p2p }); }
    }, 250);

    function open(url, rejoin) {
      ws = new WebSocket(url);
      heard = Date.now();
      ws.onopen = () => {
        retries = 0;
        heard = Date.now();
        if (rejoin) send({ t: 'rejoin', slot: me, version: opts.version });
        else send({ t: 'hello', name: opts.name, version: opts.version });
        send({ t: 'ping', ts: Date.now() });
      };
      ws.onclose = () => {
        if (started && !closing) { reconnect(); return; }
        if (timer) clearInterval(timer);
        clearInterval(ping);
        for (const p of peers.values()) p.pc?.close();
        opts.onClose?.();
      };
      ws.onerror = () => { if (!started) opts.onError?.('Connection to the game room failed.'); };
      ws.onmessage = (ev) => { heard = Date.now(); onSocketMessage(ev); };
    }
    function abandon() {
      const old = ws;
      old.onclose = old.onmessage = old.onerror = null;
      try { old.close(); } catch { /* already gone */ }
      reconnect();
    }
    async function reconnect() {
      opts.onReconnect?.('connecting');
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** retries++)));
      try { open(opts.reconnectUrl ? await opts.reconnectUrl() : opts.url, true); }
      catch { reconnect(); }
    }

    function onMessage(m, from) {
      if (from && opts.testLoss && Math.random() < opts.testLoss) return;
      if (m.type === 'ready' || m.ready) {
        markReady(m.slot !== undefined ? m.slot : (from ? from.slot : -1));
        return;
      }
      if (m.t === 'in') {
        if (m.type === 'ready' || m.ready) {
          markReady(m.slot !== undefined ? m.slot : (from ? from.slot : -1));
          return;
        }
        if (game) deliver(game, m); else early.push(m);
      }
      else if (m.t === 'ping' && from) from.dc.send(JSON.stringify({ t: 'pong', ts: m.ts }));
      else if (m.t === 'pong') {
        const ms = Date.now() - m.ts;
        if (from) { from.trip.add(ms); from.rtt = from.trip.p90(); }
        else {
          roomTrip.add(ms);
          rtt = roomTrip.p90();
          if (Math.abs(rtt - reported) > 5 || !reported) { reported = rtt; send({ t: 'rtt', ms: rtt }); }
        }
      }
    }

    // ---- direct channels (browser only)
    const webrtc = typeof RTCPeerConnection !== 'undefined';
    function peer(slot) {
      let p = peers.get(slot);
      if (p) return p;
      const pc = new RTCPeerConnection({ iceServers: opts.iceServers || [], iceTransportPolicy: opts.relayOnly ? 'relay' : 'all' });
      p = { pc, dc: null, trip: trip(), rtt: 0 };
      peers.set(slot, p);
      const use = (dc) => {
        p.dc = dc;
        dc.onopen = () => describePath(slot, pc);
        dc.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data), p); } catch { /* bad frame */ } };
      };
      pc.onicecandidate = (ev) => { if (ev.candidate) send({ t: 'sig', to: slot, data: { candidate: ev.candidate.toJSON() } }); };
      pc.ondatachannel = (ev) => use(ev.channel);
      if (me < slot) {   // the lower slot makes the offer
        use(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
        pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => send({ t: 'sig', to: slot, data: { sdp: pc.localDescription.toJSON() } }));
      }
      return p;
    }
    // Logs how a direct channel connected: host/srflx = straight between the players, relay = through TURN.
    async function describePath(slot, pc) {
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
        stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
        console.log(`[netplay] direct channel to player ${slot + 1}: ${local?.candidateType || '?'} -> ${remote?.candidateType || '?'}`);
      } catch (e) { console.warn('[netplay] getStats:', e); }
    }
    async function onSignal(from, data) {
      const { pc } = peer(from);
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ t: 'sig', to: from, data: { sdp: pc.localDescription.toJSON() } });
        }
      } else if (data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
    }

    function onSocketMessage(ev) {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'lobby') {
        me = m.you;
        if (webrtc) {
          const present = new Set(m.players.map((p) => p.slot));
          for (const [slot, p] of peers) if (!present.has(slot)) { p.pc.close(); peers.delete(slot); }
          for (const p of m.players) if (p.slot > me) peer(p.slot);
        }
        opts.onLobby?.(m);
      } else if (m.t === 'start') {
        started = true;
        if (m.you !== undefined) me = m.you;
        opts.onStart?.(m);
      }
      else if (m.type === 'ready' || m.ready) {
        markReady(m.slot);
      }
      else if (m.t === 'rejoined') {   // back in the game: resend what may have been lost
        for (const text of history) ws.send(text);
        opts.onReconnect?.('rejoined');
      }
      else if (m.t === 'error') opts.onError?.(m.msg);
      else if (m.t === 'sig' && webrtc) onSignal(m.from, m.data).catch((e) => console.warn('webrtc:', e));
      else if (m.t === 'left') {
        const fnLeft = game?._netplay_player_left || game?.netplay_player_left || game?.wasmExports?.netplay_player_left;
        if (fnLeft) fnLeft(m.slot);
        opts.onLeft?.(m.slot);
      }
      else onMessage(m, null);
    }

    function deliver(M, m) {
      const fnRemoteInput = M._netplay_remote_input || M.netplay_remote_input || M.wasmExports?.netplay_remote_input || M.asm?._netplay_remote_input;
      const fnRemoteHash = M._netplay_remote_hash || M.netplay_remote_hash || M.wasmExports?.netplay_remote_hash || M.asm?._netplay_remote_hash;
      const fnGamepad = M._input_gamepad || M.input_gamepad || M.wasmExports?.input_gamepad || M.asm?._input_gamepad;
      const fnKeyHid = M._input_key_hid || M.input_key_hid || M.wasmExports?.input_key_hid || M.asm?._input_key_hid;

      // Handle lockstep batch entries in m.d
      for (const [s, f, b, lx, ly, rx, ry, dt] of m.d || []) {
        if (fnRemoteInput) {
          try { fnRemoteInput(s, f, b, lx, ly, rx, ry, dt >>> 0); } catch (e) { console.warn('[netplay] remote_input error:', e); }
        }
        // Player 1 receives input packet from Player 2 (slot 1):
        // Inject it into virtual Gamepad 1 slot: M._input_gamepad(1, 1, buttons, lx, ly, rx, ry)
        if (s === 1 && me === 0 && fnGamepad) {
          try { fnGamepad(1, 1, b, lx, ly, rx, ry); } catch (_) {}
        }
        // Player 2 receives input packet from Player 1 (slot 0):
        if (s === 0 && me === 1 && fnGamepad) {
          try { fnGamepad(0, 1, b, lx, ly, rx, ry); } catch (_) {}
        }
      }

      const slot = m.slot !== undefined ? m.slot : (m.s !== undefined ? m.s : (m.d && m.d[0] ? m.d[0][0] : undefined));

      // 1. When Player 1 receives an input packet from Player 2 (slot 1):
      //    Inject it into the virtual Gamepad 1 slot: M._input_gamepad(1, 1, buttons, lx, ly, rx, ry)
      if (slot === 1 && me === 0 && fnGamepad) {
        const b = m.buttons !== undefined ? m.buttons : (m.d && m.d[0] ? m.d[0][2] : 0);
        const lx = m.lx !== undefined ? m.lx : (m.d && m.d[0] ? m.d[0][3] : 0);
        const ly = m.ly !== undefined ? m.ly : (m.d && m.d[0] ? m.d[0][4] : 0);
        const rx = m.rx !== undefined ? m.rx : (m.d && m.d[0] ? m.d[0][5] : 0);
        const ry = m.ry !== undefined ? m.ry : (m.d && m.d[0] ? m.d[0][6] : 0);
        try { fnGamepad(1, 1, b, lx, ly, rx, ry); } catch (_) {}
      }

      // 2. When Player 2 receives an input packet from Player 1 (slot 0):
      //    Inject it into the Keyboard HID slot: M._input_key_hid(hidCode, isDown)
      if (slot === 0 && me === 1) {
        if (fnKeyHid && (m.hid || m.hidCode !== undefined)) {
          const hidCode = m.hid ? m.hid[0] : m.hidCode;
          const isDown = m.hid ? m.hid[1] : (m.isDown ? 1 : 0);
          try { fnKeyHid(hidCode, isDown); } catch (_) {}
        }
        if (fnGamepad && (m.buttons !== undefined || (m.d && m.d[0]))) {
          const b = m.buttons !== undefined ? m.buttons : (m.d && m.d[0] ? m.d[0][2] : 0);
          const lx = m.lx !== undefined ? m.lx : (m.d && m.d[0] ? m.d[0][3] : 0);
          const ly = m.ly !== undefined ? m.ly : (m.d && m.d[0] ? m.d[0][4] : 0);
          const rx = m.rx !== undefined ? m.rx : (m.d && m.d[0] ? m.d[0][5] : 0);
          const ry = m.ry !== undefined ? m.ry : (m.d && m.d[0] ? m.d[0][6] : 0);
          try { fnGamepad(0, 1, b, lx, ly, rx, ry); } catch (_) {}
        }
      }

      for (const [s, f, lo, hi] of m.h || []) {
        if (fnRemoteHash) {
          try { fnRemoteHash(s, f, lo, hi); } catch (_) {}
        }
      }
    }

    // Drains the game's outbox to the room and every open direct channel.
    function pump() {
      if (!game) return;
      const fnPop = game._netplay_pop || game.netplay_pop || game.wasmExports?.netplay_pop;
      const fnMsg = game._netplay_msg || game.netplay_msg || game.wasmExports?.netplay_msg;
      if (!fnPop || !fnMsg) return;
      const d = [], h = [];
      try {
        while (fnPop()) {
          const v = [];
          for (let i = 0; i < 10; i++) v.push(fnMsg(i));
          if (v[0] === 1) d.push([...v.slice(1, 8), v[8] >>> 0]);   // input: slot, frame, buttons, axes, frame time (us)
          else if (v[0] === 2) h.push([v[1], v[2], v[8] >>> 0, v[9] >>> 0]);   // hash: slot, frame, lo, hi
        }
      } catch (err) {
        console.warn('[netplay] pump drain error:', err);
      }
      if (!d.length && !h.length) return;
      const text = JSON.stringify({ t: 'in', d, h });
      history.push(text);
      if (history.length > HISTORY) history.shift();
      if (ws.readyState === 1) ws.send(text);
      recent.push(...d);
      recent.splice(0, recent.length - REPEAT);
      const direct = JSON.stringify({ t: 'in', d: recent, h });
      for (const p of peers.values()) if (p.dc?.readyState === 'open') p.dc.send(direct);
    }

    function sendReady(slot) {
      const mySlot = slot !== undefined ? slot : me;
      const msg = { type: 'ready', t: 'in', ready: 1, slot: mySlot };
      send(msg);
      for (const p of peers.values()) {
        if (p.dc?.readyState === 'open') {
          try { p.dc.send(JSON.stringify(msg)); } catch (_) {}
        }
      }
    }

    function waitForAllReady(timeoutMs = 25000) {
      return new Promise((resolve) => {
        const isReady = () => {
          for (const s of readySlots) {
            if (s !== me) return true;
          }
          return false;
        };

        if (isReady()) {
          resolve(true);
          return;
        }

        let timer = null;
        const cb = () => {
          if (isReady()) {
            readyListeners.delete(cb);
            if (timer) clearTimeout(timer);
            resolve(true);
          }
        };
        readyListeners.add(cb);

        timer = setTimeout(() => {
          readyListeners.delete(cb);
          console.warn('[netplay] waitForAllReady timed out after ' + timeoutMs + 'ms');
          resolve(false);
        }, timeoutMs);
      });
    }

    function sendInput(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
      let pkt;
      if (typeof arg1 === 'object' && arg1 !== null) {
        const o = arg1;
        const s = o.slot !== undefined ? o.slot : me;
        const f = o.frame || 0;
        const b = o.buttons || 0;
        const lx = o.lx || 0, ly = o.ly || 0, rx = o.rx || 0, ry = o.ry || 0;
        const dt = o.dt || 16667;
        pkt = {
          t: 'in',
          slot: s,
          d: [[s, f, b, lx, ly, rx, ry, dt >>> 0]],
          buttons: b, lx, ly, rx, ry, dt
        };
        if (o.hidCode !== undefined || o.hid) {
          pkt.hid = o.hid || [o.hidCode, o.isDown ? 1 : 0];
          pkt.hidCode = pkt.hid[0];
          pkt.isDown = pkt.hid[1];
        }
      } else {
        const s = arg1 !== undefined ? arg1 : me;
        const f = arg2 || 0;
        const b = arg3 || 0;
        const lx = arg4 || 0, ly = arg5 || 0, rx = arg6 || 0, ry = arg7 || 0;
        const dt = arg8 || 16667;
        pkt = {
          t: 'in',
          slot: s,
          d: [[s, f, b, lx, ly, rx, ry, dt >>> 0]],
          buttons: b, lx, ly, rx, ry, dt
        };
        if (arg9 !== undefined) {
          pkt.hid = [arg9, arg10 ? 1 : 0];
          pkt.hidCode = arg9;
          pkt.isDown = arg10 ? 1 : 0;
        }
      }
      const text = JSON.stringify(pkt);
      if (ws && ws.readyState === 1) ws.send(text);
      for (const p of peers.values()) {
        if (p.dc?.readyState === 'open') {
          try { p.dc.send(text); } catch (_) {}
        }
      }
    }

    open(opts.url, false);

    return {
      start(delay) { send({ t: 'start', delay }); },
      sendReady,
      waitForAllReady,
      sendInput,
      // Hooks a running game up to the room (after it was started with the session's settings).
      // The game thread kicks the pump as soon as it queues a message (host/netplay.c); the timer is a
      // safety net.
      attach(M, pollMs = 8) {
        game = M;
        M.rcNetplayPump = pump;
        if (typeof globalThis !== 'undefined' && globalThis.Module) globalThis.Module.rcNetplayPump = pump;
        for (const m of early.splice(0)) deliver(M, m);
        timer = setInterval(pump, pollMs);
      },
      close() { closing = true; ws.close(); },
      testDrop() { abandon(); },   // tests: lose the room connection as a network drop would
      rtt: () => rtt,
      direct: () => [...peers.entries()].filter(([, p]) => p.dc?.readyState === 'open').map(([slot]) => slot),
      // for the game's status line: the round trip the inputs are riding on (the slowest direct channel,
      // else the room)
      trips: () => {
        const open = [...peers.values()].filter((p) => p.dc?.readyState === 'open');
        return { room: Math.round(rtt), direct: open.length ? Math.round(Math.max(...open.map((p) => p.rtt))) : 0 };
      },
    };
  }

  // Input delay (frames at 60 Hz) covering the slowest pair of players. An input sent at Present f is
  // needed by the others at their Present f + D - 1, so D - 1 frames must cover the one-way trip (half the
  // direct round trip where there is one, else the two trips to the room) plus up to one frame: each
  // player's Presents follow their own display, and the two displays' phases differ by anything up to a
  // frame (headless peers on one machine showed a 14 ms offset stalling every frame at D = 2). The round
  // trips are 90th percentiles of the lobby's pings, so jitter is already in them; 3 ms covers the rest.
  function autoDelay(players) {
    let oneWay = 0;
    for (const a of players)
      for (const b of players) {
        if (a.slot >= b.slot) continue;
        const direct = Math.max(a.p2p?.[b.slot] || 0, b.p2p?.[a.slot] || 0);
        const viaRoom = ((a.rtt || 0) + (b.rtt || 0)) / 2;
        oneWay = Math.max(oneWay, direct ? Math.min(direct / 2, viaRoom) : viaRoom);
      }
    return Math.max(2, Math.min(30, Math.ceil((oneWay + 3) / (1000 / 60)) + 2));
  }

  // Environment for a peer's game: deterministic simulation, this peer's slot, the session's settings.
  function gameEnv(session) {
    return {
      RC_DETERMINISTIC: '1', RC_NETPLAY: '1', RC_NP_PLAYERS: String(session.players),
      RC_NP_SLOT: String(session.you), RC_NP_DELAY: String(session.delay), RC_PADS: String(session.players),
    };
  }

  const api = {
    connect,
    gameEnv,
    autoDelay,
    sendInput(target, ...args) {
      if (target && typeof target.sendInput === 'function') {
        return target.sendInput(...args);
      }
      if (target && target.client && typeof target.client.sendInput === 'function') {
        return target.client.sendInput(...args);
      }
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RcNetplay = api;
})(typeof self !== 'undefined' ? self : this);
