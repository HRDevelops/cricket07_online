# Cricket 07 Online (Browser & Multiplayer)

[![Deploy to GitHub Pages](https://github.com/HRDevelops/cricket07_online/actions/workflows/deploy.yml/badge.svg)](https://github.com/HRDevelops/cricket07_online/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An online multiplayer port of **EA Sports Cricket 07 (2006, Windows)** running in modern web browsers via static recompilation, WebAssembly (pthreads), WebGPU, Web Audio, and deterministic lockstep netplay.

Target repository: `https://github.com/HRDevelops/cricket07_online.git`  
Upstream architecture by [Dhaiwat Pandya](https://github.com/Dhaiwat10/cricket07-browser).

---

## Core Architecture & Principles

This repository strictly adheres to three design rules:

### 1. "Bring Your Own Game" (BYOG)
Zero copyrighted game files (`.exe`, `.gob`, `.viv`, `.big`, audio/commentary) are stored or distributed in this repository.
- Players supply their own legally purchased copy of EA Sports Cricket 07.
- During the first browser visit, files are imported through the web directory picker into the browser's **Origin Private File System (OPFS)**.
- Game assets stay 100% local inside the user's browser sandbox and are never transmitted to any external server.

### 2. Free Zero-Cost Hosting
- **Web Client**: Deployed on **GitHub Pages** (via GitHub Actions) or **Cloudflare Pages**.
- **Multiplayer Relay**: Runs on a **Cloudflare Worker** (with Durable Objects) under Cloudflare's free tier, or locally using the included **Node.js WebSocket fallback server**.

### 3. Cross-Origin Isolation (COOP / COEP)
WebAssembly multi-threading (`SharedArrayBuffer`) and WebGPU strictly require cross-origin isolation:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Pre-configured mechanisms:
- **GitHub Pages**: Automatically enabled via vendored `web/coi-serviceworker.min.js` injected in `<head>` of `web/index.html`.
- **Cloudflare Pages**: Natively enabled via `web/_headers`.
- **Local Dev Server**: Enforced in Python (`web/serve.py`) and Node.js (`server/local_relay.js`).

---

## System Architecture

```
[ EA Sports Cricket 07 x86 Win32 Binary ]
                  │
                  ▼
         Ghidra Headless Analyzer
                  │ (exports functions.json)
                  ▼
        translator/x86toc.py
  (translates 31k+ functions into C)
                  │
                  ▼
            runtime/ & host/
  ├── host/render_wgpu.c  (Direct3D 8 -> WebGPU translation)
  ├── host/dsound.c       (DirectSound -> Web Audio worklet)
  ├── host/input.c        (DirectInput -> Gamepad / Keyboard HID)
  ├── host/sched.c        (Deterministic virtual clock scheduler)
  └── host/netplay.c      (Lockstep state synchronization)
                  │
                  ▼ (Emscripten emcc -sWASMFS -pthread)
          build_web/www/recomp.js + recomp.wasm
                  │
                  ▼
        web/loader.js & OPFS
  (Loads assets from client OPFS + Canvas WebGPU render)
```

---

## Directory Structure

```
├── .github/workflows/    # CI/CD: Automated deployment to GitHub Pages
├── ghidra/               # Ghidra headless scripts for function & RTTI analysis
├── host/                 # Win32, Direct3D 8, DirectSound, DirectInput Web bridges
├── runtime/              # x86 CPU emulator, dynamic interpreter, runtime headers
├── server/               # Multiplayer netplay relay
│   ├── worker.js         # Cloudflare Worker + Durable Objects room server
│   ├── local_relay.js    # Local Node.js WebSocket fallback server
│   ├── package.json      # Server dependencies (ws, wrangler)
│   └── wrangler.toml     # Cloudflare Worker configuration
├── tests/                # Differential testing harness (CPU emulator vs recompiled C)
├── tools/                # EA asset extractors and PE survey tools
├── translator/           # x86toc.py disassembler-to-C translation engine
├── web/                  # Frontend launcher, WebGPU canvas, OPFS asset loader
│   ├── index.html        # Main launcher UI (Singleplayer & Multiplayer)
│   ├── loader.js         # OPFS asset manager, WebGPU replay & input bridge
│   ├── netplay.js        # WebRTC & WebSocket lockstep transport client
│   ├── audio-worklet.js  # Low-latency Web Audio output stream
│   ├── coi-serviceworker.min.js # ServiceWorker for COOP/COEP isolation
│   ├── _headers          # Cloudflare Pages COOP/COEP headers
│   └── serve.py          # Local dev server with cross-origin isolation
├── Makefile              # Project automation tasks
├── package.json          # Root scripts for dev, relay, dist, and deploy
└── .gitignore            # Strict exclusions for binaries, assets, and caches
```

---

## Quick Start (Local Development)

### 1. Install Relay Dependencies
```bash
npm run relay:install
# or: make setup
```

### 2. Start the Local Multiplayer Relay
In one terminal:
```bash
npm run relay
# or: make relay
# -> Running on http://localhost:8080 (WebSocket at ws://localhost:8080/netplay/:code)
```

### 3. Start the Web Client
In a second terminal:
```bash
npm run dev
# or: make serve
# -> Serving on http://localhost:8007/
```

Open `http://localhost:8007/?netplay=http://localhost:8080` in Chrome, Edge, or Firefox (WebGPU & SharedArrayBuffer enabled).

---

## Static Recompilation Workflow (Building from Scratch)

If you are recompiling your own game executable:

### Prerequisites
- Python 3 with `capstone` and `pefile` (`pip install capstone pefile`)
- [Ghidra](https://ghidra-sre.org/) (version 12.x+)
- [Emscripten](https://emscripten.org/) SDK (active on PATH)

### 1. Export Function List
```bash
GHIDRA=/path/to/ghidra ghidra/export.sh /path/to/Cricket07.exe work/functions.json
```

### 2. Configure Profile
```bash
mkdir -p work
cp host/profile.h work/profile.h
# Edit work/profile.h with your executable characteristics
```

### 3. Translate to C & Compile WebAssembly
```bash
PROFILE=work/profile.h ./build.sh /path/to/Cricket07.exe work/functions.json
PROFILE=work/profile.h ./build_web.sh
```
This produces `build_web/www/recomp.js` and `build_web/www/recomp.wasm`.

### 4. Create Web Distribution
```bash
npm run build:dist
# or: make dist
```
Outputs ready-to-deploy static files in `dist/`.

---

## Multiplayer Relay Deployment

### Option A: Cloudflare Workers (Free Global Relay)
1. Deploy the room worker:
   ```bash
   cd server
   npx wrangler deploy
   ```
2. Set your HMAC signing secret:
   ```bash
   npx wrangler secret put NETPLAY_SECRET
   ```
3. (Optional) Configure Cloudflare Realtime TURN for NAT traversal:
   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```
4. Access the web client pointing to your worker:
   ```
   https://hrdevelops.github.io/cricket07_online/?netplay=https://cricket07-netplay.<your-subdomain>.workers.dev
   ```

### Option B: Local Node.js Relay
Run the standalone server on any VPS or local machine:
```bash
node server/local_relay.js --port 8080
```

---

## Controls

| Action | Keyboard | Gamepad |
| :--- | :--- | :--- |
| **Normal Shot / Stock Delivery** | `S` | Cross (A) |
| **Lofted Shot (Hold)** | `Left Shift` | L1 / Left Bumper |
| **Advanced Shot / Special Delivery** | `D` | Circle (B) |
| **Take Run** | `D` | Circle (B) |
| **Cancel Run** | `A` | Square (X) |
| **Shot / Ball Placement** | Arrow Keys `←` `↑` `↓` `→` | Left Analog Stick / D-Pad |
| **Menu Select** | `S` | Cross (A) |
| **Menu Back** | `W` | Triangle (Y) |
| **Pause Game** | `Esc` | Start |
| **Fullscreen Toggle** | `Alt` + `Enter` | — |

---

## License & Attribution

- Source code licensed under the **MIT License**.
- EA Sports and Cricket 07 are trademarks and copyrights of **Electronic Arts Inc.**. This project is an independent educational research and reverse-engineering preservation initiative and is not affiliated with or endorsed by Electronic Arts.
