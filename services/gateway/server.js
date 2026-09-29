'use strict';

/**
 * gateway — the edge tier.
 *
 * The only service with a port published to the host, and the only member of
 * the `edge` network. It also sits on `app`, which lets it reach the api
 * instances; it is deliberately not on `data`, so it cannot reach the vault.
 * That gap is the security property the lab demonstrates, and /lab/matrix
 * measures it live rather than asserting it.
 *
 * Responsibilities:
 *   - serve the dashboard
 *   - round-robin proxy /api/* across healthy api instances
 *   - poll backend health so a dead instance drops out of rotation
 *   - build the live reachability matrix by probing locally and by asking
 *     each api instance to probe on its behalf
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  TOPOLOGY,
  PROBE_SOURCES,
  PROBE_TARGETS,
  expectedMatrix,
  tcpProbe,
  httpGetJSON,
  sendJSON,
  createLabServer,
} = require('../common/lab');

const PORT = Number(process.env.PORT || 8080);
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 2000);
const DASHBOARD = path.join(__dirname, '..', '..', 'public', 'index.html');

const backends = (process.env.BACKENDS || 'api-1:4000,api-2:4000')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [host, port] = entry.split(':');
    return {
      name: host,
      host,
      port: Number(port),
      healthy: false,
      requests: 0,
      lastLatencyMs: null,
      lastError: null,
      lastCheck: null,
    };
  });

let rotation = 0;
let rejectedNoBackend = 0;

// ---------------------------------------------------------------- health

async function checkBackend(backend) {
  const started = Date.now();
  try {
    const response = await httpGetJSON(`http://${backend.host}:${backend.port}/health`, 1000);
    backend.healthy = response.status === 200 && response.body.status === 'ok';
    backend.lastError = backend.healthy ? null : `unexpected health response (${response.status})`;
  } catch (err) {
    backend.healthy = false;
    backend.lastError = err.code || err.message;
  }
  backend.lastLatencyMs = Date.now() - started;
  backend.lastCheck = new Date().toISOString();
}

function pollBackends() {
  return Promise.all(backends.map(checkBackend));
}

setInterval(pollBackends, HEALTH_INTERVAL_MS).unref();
pollBackends();

/** Round-robin across healthy backends only, so an unhealthy one drops out. */
function pickBackend() {
  const healthy = backends.filter((b) => b.healthy);
  if (healthy.length === 0) return null;
  const chosen = healthy[rotation % healthy.length];
  rotation += 1;
  return chosen;
}

// ----------------------------------------------------------------- proxy

function proxyRequest(url, req, res) {
  const backend = pickBackend();

  if (!backend) {
    rejectedNoBackend += 1;
    return sendJSON(res, 503, {
      error: 'no healthy backend available',
      backends: backends.map((b) => ({ name: b.name, healthy: b.healthy, lastError: b.lastError })),
    });
  }

  backend.requests += 1;
  const upstreamPath = (url.pathname.replace(/^\/api/, '') || '/') + url.search;
  const started = Date.now();

  const upstream = http.request(
    {
      host: backend.host,
      port: backend.port,
      path: upstreamPath,
      method: req.method,
      headers: { ...req.headers, host: `${backend.host}:${backend.port}` },
      timeout: 5000,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, {
        ...upstreamRes.headers,
        'x-served-by': backend.name,
        'x-gateway-latency-ms': String(Date.now() - started),
      });
      upstreamRes.pipe(res);
    }
  );

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));

  upstream.on('error', (err) => {
    // Take the backend out of rotation immediately rather than waiting for the
    // next health poll, so a failure mid-request does not hit the next caller.
    backend.healthy = false;
    backend.lastError = err.code || err.message;
    if (!res.headersSent) {
      sendJSON(res, 502, { error: `upstream ${backend.name} failed`, detail: err.code || err.message });
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
}

// ---------------------------------------------------------------- matrix

/**
 * Measures who can actually reach whom. The gateway probes its own row
 * directly; for the api rows it asks each instance to run the probe and report
 * back, which works because the gateway shares the `app` network with both.
 */
async function buildMatrix() {
  const actual = {};

  for (const source of PROBE_SOURCES) {
    actual[source] = {};

    for (const target of PROBE_TARGETS) {
      const targetPort = TOPOLOGY.services[target].port;

      if (source === 'gateway') {
        const result = await tcpProbe(target, targetPort);
        actual[source][target] = { ok: result.ok, error: result.error, ms: result.ms };
        continue;
      }

      try {
        const sourcePort = TOPOLOGY.services[source].port;
        const relay = await httpGetJSON(
          `http://${source}:${sourcePort}/probe?target=${target}:${targetPort}`,
          4000
        );
        actual[source][target] = { ok: relay.body.ok, error: relay.body.error, ms: relay.body.ms };
      } catch (err) {
        actual[source][target] = { ok: false, error: `probe relay failed: ${err.message}`, relayFailed: true };
      }
    }
  }

  const expected = expectedMatrix();
  const mismatches = [];
  for (const source of PROBE_SOURCES) {
    for (const target of PROBE_TARGETS) {
      if (expected[source][target] !== actual[source][target].ok) {
        mismatches.push({
          from: source,
          to: target,
          expected: expected[source][target] ? 'reachable' : 'blocked',
          actual: actual[source][target].ok ? 'reachable' : 'blocked',
          error: actual[source][target].error,
        });
      }
    }
  }

  return { sources: PROBE_SOURCES, targets: PROBE_TARGETS, expected, actual, mismatches };
}

// ---------------------------------------------------------------- server

createLabServer({
  service: 'gateway',
  port: PORT,
  routes: {
    '/': async (url, req, res) => {
      fs.readFile(DASHBOARD, (err, buffer) => {
        if (err) return sendJSON(res, 500, { error: `dashboard unavailable: ${err.message}` });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': buffer.length,
          'cache-control': 'no-store',
        });
        res.end(buffer);
      });
    },

    '/lab/topology': async () => ({
      status: 200,
      body: { topology: TOPOLOGY, expected: expectedMatrix() },
    }),

    '/lab/backends': async () => ({
      status: 200,
      body: {
        rejectedNoBackend,
        totalRequests: backends.reduce((sum, b) => sum + b.requests, 0),
        backends: backends.map((b) => ({
          name: b.name,
          address: `${b.host}:${b.port}`,
          healthy: b.healthy,
          requests: b.requests,
          lastLatencyMs: b.lastLatencyMs,
          lastError: b.lastError,
          lastCheck: b.lastCheck,
        })),
      },
    }),

    '/lab/matrix': async () => ({ status: 200, body: await buildMatrix() }),

    /** Relays the vault's own egress check, which the edge cannot run itself. */
    '/lab/egress': async () => {
      const healthy = backends.filter((b) => b.healthy);
      if (healthy.length === 0) return { status: 503, body: { error: 'no healthy api instance to relay through' } };
      try {
        const relay = await httpGetJSON(`http://${healthy[0].host}:${healthy[0].port}/vault-egress`, 6000);
        return { status: 200, body: { relayedVia: healthy[0].name, ...relay.body } };
      } catch (err) {
        return { status: 502, body: { error: `egress relay failed: ${err.message}` } };
      }
    },
  },

  // Everything under /api/ is load balanced to the application tier.
  fallback: async (url, req, res) => {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return proxyRequest(url, req, res);
    }
    return { status: 404, body: { error: 'not found', path: url.pathname, hint: 'try / or /api/records' } };
  },
});
