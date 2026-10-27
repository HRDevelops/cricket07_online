#!/usr/bin/env node
/**
 * Local Node.js WebSocket Netplay Relay Server for Cricket 07.
 * 
 * Protocol-compatible fallback for the Cloudflare Worker + Durable Objects architecture.
 * Implements ticket issuance (GET /_netplay_ticket) and WebSocket room relay (/netplay/:code).
 * 
 * Usage:
 *   node server/local_relay.js [--port 8080] [--secret any-secret-key]
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch (e) {
  console.error('\n[!] Missing dependency "ws". Please run: npm --prefix server install\n');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || process.argv.find((a, i) => process.argv[i - 1] === '--port') || '8080', 10);
const SECRET = process.env.NETPLAY_SECRET || process.argv.find((a, i) => process.argv[i - 1] === '--secret') || 'local-dev-secret';
const TICKET_SECONDS = 3600;
const MAX_PLAYERS = 4;
const REJOIN_GRACE_MS = 15000;

function hmac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

function ticketValid(ticket) {
  if (!ticket) return false;
  const [exp, sig] = String(ticket).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = hmac(SECRET, `netplay:${exp}`);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function getIceServers() {
  return [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

// In-memory room manager
class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Set(); // { ws, slot, name, version, rtt, p2p }
    this.started = null;      // { players, delay }
    this.away = new Map();    // slot -> { slot, name, version, rtt, p2p, at, timer }
  }

  peers() {
    return Array.from(this.clients).filter((c) => c.slot >= 0);
  }

  send(ws, msg) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch (_) {}
    }
  }

  broadcastLobby() {
    const players = this.peers().map(({ slot, name, version, rtt, p2p }) => ({
      slot,
      name,
      version,
      rtt,
      p2p: p2p || {},
      via: 'local'
    })).sort((a, b) => a.slot - b.slot);

    for (const p of this.peers()) {
      this.send(p.ws, {
        t: 'lobby',
        you: p.slot,
        host: p.slot === 0,
        players,
        started: this.started,
        colo: 'LOCAL'
      });
    }
  }

  handleMessage(client, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Hello: assign slot
    if (msg.t === 'hello' && client.slot < 0) {
      if (this.started) {
        this.send(client.ws, { t: 'error', msg: 'This game has already started.' });
        client.ws.close(4000, 'started');
        return;
      }
      const used = new Set(this.peers().map((p) => p.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      if (slot >= MAX_PLAYERS) {
        this.send(client.ws, { t: 'error', msg: 'The room is full.' });
        client.ws.close(4001, 'full');
        return;
      }

      client.slot = slot;
      client.name = String(msg.name || `Player ${slot + 1}`).slice(0, 24);
      client.version = String(msg.version || '');
      client.rtt = 0;
      console.log(`[Room ${this.code}] Player joined: "${client.name}" in slot ${slot}`);
      this.broadcastLobby();
      return;
    }

    if (msg.t === 'ping') {
      this.send(client.ws, { t: 'pong', ts: msg.ts });
      return;
    }

    // Rejoin: dropped client reconnects
    if (msg.t === 'rejoin' && client.slot < 0) {
      const slot = Number(msg.slot);
      const awayData = this.away.get(slot);
      if (!this.started || !awayData || this.peers().some((p) => p.slot === slot)) {
        this.send(client.ws, { t: 'error', msg: 'Could not rejoin the game.' });
        client.ws.close(4002, 'rejoin');
        return;
      }
      clearTimeout(awayData.timer);
      this.away.delete(slot);
      client.slot = slot;
      client.name = awayData.name;
      client.version = awayData.version;
      client.rtt = awayData.rtt;
      client.p2p = awayData.p2p;
      console.log(`[Room ${this.code}] Player rejoined: "${client.name}" in slot ${slot}`);
      this.send(client.ws, { t: 'rejoined', slot });
      return;
    }

    if (client.slot < 0) return;

    // RTT sample from client to room
    if (msg.t === 'rtt') {
      client.rtt = Math.max(0, Math.min(5000, Math.round(Number(msg.ms) || 0)));
      if (!this.started) this.broadcastLobby();
      return;
    }

    // Start match (host only)
    if (msg.t === 'start' && client.slot === 0 && !this.started) {
      const peers = this.peers();
      const versions = new Set(peers.map((p) => p.version));
      if (versions.size > 1) {
        this.send(client.ws, { t: 'error', msg: 'Players have different game builds or files; everyone must reload the page.' });
        return;
      }
      const slots = peers.map((p) => p.slot).sort((a, b) => a - b);
      if (slots.some((s, i) => s !== i)) {
        this.send(client.ws, { t: 'error', msg: 'Waiting for the player list to settle; try again.' });
        return;
      }

      this.started = {
        players: peers.length,
        delay: Math.max(2, Math.min(30, Number(msg.delay) || 6))
      };
      console.log(`[Room ${this.code}] Match started with ${peers.length} players, delay ${this.started.delay}`);
      for (const p of peers) {
        this.send(p.ws, { t: 'start', ...this.started, you: p.slot });
      }
      return;
    }

    // WebRTC signaling relay between peers
    if (msg.t === 'sig') {
      for (const p of this.peers()) {
        if (p.slot === msg.to) {
          this.send(p.ws, { t: 'sig', from: client.slot, data: msg.data });
        }
      }
      return;
    }

    // Direct P2P round-trip updates
    if (msg.t === 'p2p') {
      const p2p = {};
      for (const [k, v] of Object.entries(msg.rtt || {})) {
        p2p[Number(k)] = Math.max(0, Math.min(5000, Math.round(Number(v) || 0)));
      }
      client.p2p = p2p;
      if (!this.started) this.broadcastLobby();
      return;
    }

    // Game input relay (in)
    if (msg.t === 'in') {
      for (const p of this.peers()) {
        if (p.slot !== client.slot) {
          try { p.ws.send(raw); } catch (_) {}
        }
      }
    }
  }

  handleDisconnect(client) {
    this.clients.delete(client);
    if (client.slot < 0) return;
    const slot = client.slot;
    console.log(`[Room ${this.code}] Player left: slot ${slot} ("${client.name}")`);

    if (!this.started) {
      for (const p of this.peers()) {
        this.send(p.ws, { t: 'left', slot });
      }
      this.broadcastLobby();
      if (this.peers().length === 0) {
        rooms.delete(this.code);
        console.log(`[Room ${this.code}] Room destroyed (empty)`);
      }
      return;
    }

    // Match in progress: allow 15s grace period for reconnection
    const timer = setTimeout(() => {
      this.away.delete(slot);
      for (const p of this.peers()) {
        this.send(p.ws, { t: 'left', slot });
      }
      if (this.peers().length === 0 && this.away.size === 0) {
        rooms.delete(this.code);
        console.log(`[Room ${this.code}] Room destroyed after grace period expired`);
      }
    }, REJOIN_GRACE_MS);

    this.away.set(slot, { ...client, at: Date.now(), timer });
  }
}

const rooms = new Map(); // code -> Room

function getOrCreateRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = new Room(code);
    rooms.set(code, r);
    console.log(`[Room ${code}] Room created`);
  }
  return r;
}

// HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/_netplay_ticket' && req.method === 'GET') {
    const exp = Math.floor(Date.now() / 1000) + TICKET_SECONDS;
    const ticket = `${exp}.${hmac(SECRET, `netplay:${exp}`)}`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ticket, iceServers: getIceServers() }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'cricket07-netplay-local-relay',
      activeRooms: rooms.size,
      time: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Cricket 07 Netplay Relay Server. Use with ?netplay=http://localhost:' + PORT);
});

// WebSocket Server
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/netplay/')) {
    socket.destroy();
    return;
  }

  const code = url.pathname.slice('/netplay/'.length).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const ticket = url.searchParams.get('ticket');
  if (!ticketValid(ticket)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getOrCreateRoom(code);
    const client = { ws, slot: -1, name: '', version: '', rtt: 0, p2p: {} };
    room.clients.add(client);

    ws.on('message', (data) => room.handleMessage(client, data.toString()));
    ws.on('close', () => room.handleDisconnect(client));
    ws.on('error', () => room.handleDisconnect(client));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
============================================================
  Cricket 07 Netplay Local Relay Server
  Status:  Running on http://localhost:${PORT}
  Rooms:   ws://localhost:${PORT}/netplay/:code
  Ticket:  http://localhost:${PORT}/_netplay_ticket
============================================================
  To connect the browser client:
  Open: http://localhost:8007/?netplay=http://localhost:${PORT}
============================================================
`);
});
