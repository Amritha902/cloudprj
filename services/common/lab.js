'use strict';

/**
 * Shared lab plumbing: the topology definition, network probes, and the
 * small HTTP server every service is built on.
 *
 * The topology below is the single source of truth. docker-compose.yml
 * mirrors it, the dashboard renders it, and the test suite derives its
 * expected reachability matrix from it — so a change here shows up
 * everywhere instead of drifting.
 */

const http = require('http');
const net = require('net');
const dns = require('dns');
const os = require('os');
const { URL } = require('url');

const TOPOLOGY = {
  networks: {
    edge: {
      subnet: '172.28.0.0/24',
      internal: false,
      role: 'Public tier. The only tier with a port published to the host.',
    },
    app: {
      subnet: '172.28.1.0/24',
      internal: false,
      role: 'Private application tier. Reachable from the gateway, never from the host.',
    },
    data: {
      subnet: '172.28.2.0/24',
      internal: true,
      role: 'Isolated data tier. No route off the host, no published port.',
    },
  },
  services: {
    gateway: {
      port: 8080,
      networks: ['edge', 'app'],
      publishedPort: 8080,
      role: 'Layer-7 reverse proxy and load balancer',
    },
    'api-1': {
      port: 4000,
      networks: ['app', 'data'],
      role: 'Stateless application instance',
    },
    'api-2': {
      port: 4000,
      networks: ['app', 'data'],
      role: 'Stateless application instance',
    },
    vault: {
      port: 7000,
      networks: ['data'],
      role: 'Data service, private tier only',
    },
  },
};

// Rows and columns of the reachability matrix. The gateway can ask any
// PROBE_SOURCE to run a probe for it, because it shares a network with each.
const PROBE_SOURCES = ['gateway', 'api-1', 'api-2'];
const PROBE_TARGETS = ['gateway', 'api-1', 'api-2', 'vault'];

/** Two services can reach each other iff they sit on at least one common network. */
function sharesNetwork(a, b) {
  if (a === b) return true;
  const A = TOPOLOGY.services[a];
  const B = TOPOLOGY.services[b];
  if (!A || !B) return false;
  return A.networks.some((n) => B.networks.includes(n));
}

/** The reachability the topology promises — what the live probes get compared against. */
function expectedMatrix() {
  const matrix = {};
  for (const source of PROBE_SOURCES) {
    matrix[source] = {};
    for (const target of PROBE_TARGETS) {
      matrix[source][target] = sharesNetwork(source, target);
    }
  }
  return matrix;
}

/**
 * Probes are deliberately restricted to declared lab services on their declared
 * ports. Without this an exposed /probe endpoint would be an open port scanner
 * for anything the container can route to.
 */
function parseAllowedTarget(target) {
  if (typeof target !== 'string') return null;
  const [host, portText] = target.split(':');
  const service = TOPOLOGY.services[host];
  if (!service) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port !== service.port) return null;
  return { host, port };
}

/**
 * TCP connect test. Distinguishes the two failure modes that matter here:
 * ENOTFOUND (Docker's embedded DNS refuses to resolve a service you share no
 * network with) and ETIMEDOUT/ECONNREFUSED (name resolved, packets did not land).
 */
function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

function dnsLookup(name) {
  return new Promise((resolve) => {
    dns.lookup(name, { all: true }, (err, addresses) => {
      if (err) return resolve({ ok: false, error: err.code || err.message });
      resolve({ ok: true, addresses: addresses.map((a) => a.address) });
    });
  });
}

function httpGetJSON(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error(`invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    request.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Non-loopback IPv4 addresses, one per attached Docker network. */
function localAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([iface, addrs]) =>
    (addrs || [])
      .filter((a) => a.family === 'IPv4' && !a.internal)
      .map((a) => ({ interface: iface, address: a.address, cidr: a.cidr }))
  );
}

/** Map an address back to the lab network whose subnet contains it. */
function networkFor(address) {
  const octets = address.split('.').map(Number);
  for (const [name, net_] of Object.entries(TOPOLOGY.networks)) {
    const base = net_.subnet.split('/')[0].split('.').map(Number);
    if (octets[0] === base[0] && octets[1] === base[1] && octets[2] === base[2]) return name;
  }
  return 'unknown';
}

/**
 * Builds a service. Every service gets the same introspection endpoints so the
 * dashboard and the tests can interrogate any of them the same way.
 */
function createLabServer({ service, port, routes = {}, fallback = null }) {
  const startedAt = Date.now();

  const baseRoutes = {
    '/health': async () => ({
      status: 200,
      body: { service, status: 'ok', instance: os.hostname(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
    }),

    '/whoami': async () => {
      const addresses = localAddresses().map((a) => ({ ...a, network: networkFor(a.address) }));
      return {
        status: 200,
        body: {
          service,
          instance: os.hostname(),
          networks: TOPOLOGY.services[service] ? TOPOLOGY.services[service].networks : [],
          addresses,
        },
      };
    },

    '/netinfo': async () => ({
      status: 200,
      body: { service, instance: os.hostname(), addresses: localAddresses() },
    }),

    '/dns': async (url) => {
      const name = url.searchParams.get('name');
      if (!TOPOLOGY.services[name]) {
        return { status: 400, body: { error: 'unknown service name', allowed: Object.keys(TOPOLOGY.services) } };
      }
      const result = await dnsLookup(name);
      return { status: 200, body: { from: service, name, ...result } };
    },

    '/probe': async (url) => {
      const raw = url.searchParams.get('target');
      const target = parseAllowedTarget(raw);
      if (!target) {
        return {
          status: 400,
          body: {
            error: 'target must be <service>:<declared-port> of a lab service',
            allowed: Object.entries(TOPOLOGY.services).map(([n, s]) => `${n}:${s.port}`),
          },
        };
      }
      const result = await tcpProbe(target.host, target.port);
      return { status: 200, body: { from: service, target: raw, ...result } };
    },
  };

  const handlers = { ...baseRoutes, ...routes };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Exact-path routing, with an optional fallback for prefix routes
    // (the gateway proxies everything under /api/ that way).
    const handler = handlers[url.pathname] || fallback;

    if (!handler) {
      return sendJSON(res, 404, { error: 'not found', path: url.pathname, service, routes: Object.keys(handlers) });
    }

    try {
      const result = await handler(url, req, res);
      if (result === undefined) return; // handler wrote the response itself
      sendJSON(res, result.status, result.body);
    } catch (err) {
      sendJSON(res, 500, { error: err.message, service });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const addresses = localAddresses()
      .map((a) => `${networkFor(a.address)}=${a.address}`)
      .join(' ');
    console.log(`[${service}] listening on :${port}  ${addresses}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

module.exports = {
  TOPOLOGY,
  PROBE_SOURCES,
  PROBE_TARGETS,
  sharesNetwork,
  expectedMatrix,
  parseAllowedTarget,
  tcpProbe,
  dnsLookup,
  httpGetJSON,
  sendJSON,
  localAddresses,
  networkFor,
  createLabServer,
};
