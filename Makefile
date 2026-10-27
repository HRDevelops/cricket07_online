# ==============================================================================
# Cricket 07 Online - Makefile
# Architecture: Static Recompilation to WebAssembly/WebGPU + Lockstep Netplay
# ==============================================================================

SHELL := /bin/bash
PYTHON ?= python3
NODE ?= node
NPM ?= npm
PORT ?= 8007
RELAY_PORT ?= 8080

.PHONY: all help setup serve relay dist clean build-wasm deploy-worker

all: help

help:
	@echo "========================================================================"
	@echo "Cricket 07 Online - Build & Execution Targets"
	@echo "========================================================================"
	@echo "  make setup          Install local relay server dependencies"
	@echo "  make serve          Start local web server with COOP/COEP (port $(PORT))"
	@echo "  make relay          Start local WebSocket multiplayer relay (port $(RELAY_PORT))"
	@echo "  make dist           Bundle frontend and headers to dist/ for deployment"
	@echo "  make build-wasm     Compile recompiled C to WebAssembly via Emscripten"
	@echo "  make deploy-worker  Deploy multiplayer room server to Cloudflare Workers"
	@echo "  make clean          Clean intermediate build and dist artifacts"
	@echo "========================================================================"

setup:
	@echo "Installing server dependencies..."
	@cd server && $(NPM) install

serve:
	@echo "Starting web server on http://localhost:$(PORT)..."
	@$(PYTHON) web/serve.py --port $(PORT)

relay:
	@echo "Starting local netplay relay on http://localhost:$(RELAY_PORT)..."
	@$(NODE) server/local_relay.js --port $(RELAY_PORT)

dist:
	@echo "Creating distribution bundle in dist/..."
	@mkdir -p dist/build
	@cp web/index.html dist/
	@cp web/loader.js dist/
	@cp web/netplay.js dist/
	@cp web/audio-worklet.js dist/
	@cp web/coi-serviceworker.min.js dist/
	@cp web/_headers dist/
	@if [ -d "web/build" ]; then cp -r web/build/* dist/build/; elif [ -d "build_web/www" ]; then cp -r build_web/www/* dist/build/; fi
	@echo "Distribution package ready in dist/"

build-wasm:
	@echo "Compiling WebAssembly bundle..."
	@bash build_web.sh

deploy-worker:
	@echo "Deploying Netplay relay to Cloudflare Workers..."
	@cd server && npx wrangler deploy

clean:
	@echo "Cleaning build artifacts..."
	@rm -rf dist build build_web out_all out_trace work tests/results
	@echo "Clean completed."
