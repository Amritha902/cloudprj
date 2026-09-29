'use strict';

/**
 * Verifies the running topology from the host's point of view.
 *
 * Everything here is measured against the live containers — nothing is mocked.
 * Run it with the lab up:
 *
 *   ./scripts/lab.sh up
 *   ./scripts/lab.sh test
 *
 * Exits non-zero on the first failing assertion set, so CI can gate on it.
 */

const http = require('http');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const GATEWAY = process.env.NETLAB_GATEWAY || 'http://127.0.0.1:8080';
const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.yml');

const results = [];
let failures = 0;

// ------------------------------------------------------------- assertions

function record(name, passed, detail, skipped = false) {
  results.push({ name, passed, detail, skipped });
  if (!passed && !skipped) failures += 1;
  const mark = skipped ? 'SKIP' : passed ? 'PASS' : 'FAIL';
  console.log(`  ${mark.padEnd(4)}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

function check(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

function skip(name, why) {
  record(name, true, why, true);
}

// ---------------------------------------------------------------- helpers

function request(pathname, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, GATEWAY);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let parsed = body;
        if ((res.headers['content-type'] || '').includes('json')) {
          try {
            parsed = JSON.parse(body);
          } catch {
            /* leave as text */
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text: body });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${pathname}`)));
    req.on('error', reject);
  });
}

function tcpConnect(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(args) {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dockerAvailable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthyBackends(count, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('/lab/backends');
      const healthy = res.body.backends.filter((b) => b.healthy).length;
      if (healthy >= count) return true;
    } catch {
      /* gateway still starting */
    }
    await sleep(1000);
  }
  return false;
}

// -------------------------------------------------------------- the suite

async function ingress() {
  console.log('\nIngress — only the gateway is published');

  const health = await request('/health');
  check(
    'gateway answers on the published port',
    health.status === 200 && health.body.service === 'gateway',
    `status=${health.status} service=${health.body.service}`
  );

  const dashboard = await request('/');
  check(
    'gateway serves the dashboard at /',
    dashboard.status === 200 && dashboard.text.includes('Cloud Network Lab'),
    `status=${dashboard.status}, ${dashboard.text.length} bytes of HTML`
  );

  // The api and vault tiers declare no `ports:` mapping, so nothing is bound
  // on the host loopback for them.
  for (const [name, port] of [['api', 4000], ['vault', 7000]]) {
    const probe = await tcpConnect('127.0.0.1', port, 2000);
    check(
      `${name} tier is not published on the host loopback (127.0.0.1:${port})`,
      !probe.ok,
      `connect -> ${probe.ok ? 'REACHABLE (unexpected)' : probe.error}`
    );
  }
}

async function loadBalancing() {
  console.log('\nLoad balancing — round-robin across the application tier');

  const servers = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await request('/api/whoami');
    if (res.status !== 200) {
      check('all proxied requests succeed', false, `request ${i + 1} returned ${res.status}`);
      return;
    }
    servers.push(res.headers['x-served-by']);
  }

  const distinct = [...new Set(servers)].sort();
  check('all 8 proxied requests succeeded', true, `X-Served-By sequence: ${servers.join(' ')}`);
  check(
    'traffic is spread over both api instances',
    distinct.length === 2 && distinct.includes('api-1') && distinct.includes('api-2'),
    `distinct backends: ${distinct.join(', ')}`
  );
}

async function endToEnd() {
  console.log('\nEnd-to-end path — edge -> app -> data');

  const res = await request('/api/records');
  check(
    'gateway -> api -> vault returns data from the isolated tier',
    res.status === 200 && Array.isArray(res.body.records) && res.body.records.length > 0,
    `status=${res.status} servedBy=${res.body.servedBy} records=${res.body.count} hops=${(res.body.hops || []).join(' -> ')}`
  );
  check(
    'the response really came from the vault',
    res.body.records && res.body.records[0].tier === 'data',
    `first record: ${JSON.stringify(res.body.records && res.body.records[0])}`
  );
}

async function segmentation() {
  console.log('\nSegmentation — measured reachability vs the declared topology');

  const res = await request('/lab/matrix', 20000);
  const { expected, actual, mismatches, sources, targets } = res.body;

  for (const source of sources) {
    const row = targets
      .map((t) => `${t}:${actual[source][t].ok ? 'open' : 'blocked'}`)
      .join('  ');
    console.log(`        ${source.padEnd(8)} ${row}`);
  }

  check(
    'gateway cannot reach the vault (no shared network)',
    actual.gateway.vault.ok === false,
    `gateway -> vault:7000 -> ${actual.gateway.vault.error} (DNS refuses to resolve a service you share no network with)`
  );
  check(
    'api-1 can reach the vault (shares the data network)',
    actual['api-1'].vault.ok === true,
    `api-1 -> vault:7000 -> connected in ${actual['api-1'].vault.ms}ms`
  );
  check(
    'api-2 can reach the vault (shares the data network)',
    actual['api-2'].vault.ok === true,
    `api-2 -> vault:7000 -> connected in ${actual['api-2'].vault.ms}ms`
  );
  check(
    'gateway can reach both api instances (shares the app network)',
    actual.gateway['api-1'].ok === true && actual.gateway['api-2'].ok === true,
    'gateway -> api-1:4000, api-2:4000 both connected'
  );
  check(
    'every measured edge matches the declared topology',
    mismatches.length === 0,
    mismatches.length === 0
      ? `${expected ? Object.keys(expected).length : 0} rows verified, 0 mismatches`
      : `mismatches: ${JSON.stringify(mismatches)}`
  );
}

async function serviceDiscovery() {
  console.log('\nService discovery — Docker embedded DNS');

  const fromApi = await request('/api/dns?name=vault');
  check(
    'api-1 resolves the name "vault" to an address in the data subnet',
    fromApi.body.ok === true && (fromApi.body.addresses || []).some((a) => a.startsWith('172.28.2.')),
    `vault -> ${(fromApi.body.addresses || []).join(', ')}`
  );

  const gatewayView = await request('/dns?name=vault');
  check(
    'the same name does not resolve from the gateway',
    gatewayView.body.ok === false,
    `gateway resolving "vault" -> ${gatewayView.body.error}`
  );
}

async function failover() {
  console.log('\nFailover — health checks drop a dead instance out of rotation');

  if (!dockerAvailable()) {
    skip('failover: stopping api-2 keeps the service up', 'docker CLI unavailable on this host');
    return;
  }

  try {
    compose(['stop', 'api-2']);
  } catch (err) {
    skip('failover: stopping api-2 keeps the service up', `could not stop api-2: ${err.message}`);
    return;
  }

  try {
    // Give the gateway's health poller a cycle or two to notice.
    await sleep(5000);

    const servers = [];
    let allOk = true;
    for (let i = 0; i < 6; i += 1) {
      const res = await request('/api/whoami');
      if (res.status !== 200) allOk = false;
      servers.push(res.headers['x-served-by'] || `HTTP ${res.status}`);
    }

    check(
      'requests keep succeeding with api-2 stopped',
      allOk,
      `responses: ${servers.join(' ')}`
    );
    check(
      'all traffic shifts to the surviving instance',
      servers.every((s) => s === 'api-1'),
      `every request served by api-1: ${servers.every((s) => s === 'api-1')}`
    );
  } finally {
    compose(['start', 'api-2']);
    const recovered = await waitForHealthyBackends(2, 40000);
    check('api-2 rejoins the rotation after restart', recovered, 'both backends healthy again');
  }
}

async function egressInfo() {
  console.log('\nEgress (informational)');

  try {
    const res = await request('/lab/egress', 15000);
    console.log(
      `        vault -> 1.1.1.1:443 : ${res.body.reachable ? 'REACHABLE' : `blocked (${res.body.error})`}` +
        ` — relayed via ${res.body.relayedVia || res.body.relayedBy}`
    );
    console.log('        (informational only: a sandbox with no egress of its own would pass this trivially)');
  } catch (err) {
    console.log(`        egress check unavailable: ${err.message}`);
  }
}

// ------------------------------------------------------------------- main

async function main() {
  console.log('Cloud Network Lab — verifying the live topology');
  console.log(`gateway: ${GATEWAY}`);

  const ready = await waitForHealthyBackends(2, 60000);
  if (!ready) {
    console.error('\nERROR: gateway never reported two healthy backends. Is the lab up? (./scripts/lab.sh up)');
    process.exit(1);
  }

  await ingress();
  await loadBalancing();
  await endToEnd();
  await segmentation();
  await serviceDiscovery();
  await failover();
  await egressInfo();

  const passed = results.filter((r) => r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  console.log('\n' + '-'.repeat(62));
  console.log(`  ${passed} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ''}`);
  console.log('-'.repeat(62));

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.stack || err.message}`);
  process.exit(1);
});
