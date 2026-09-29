'use strict';

/**
 * vault — the data tier.
 *
 * Attached to the `data` network only, which is declared `internal: true`.
 * That has two consequences worth seeing in the dashboard:
 *   - no host port is published, so the host cannot reach it at all;
 *   - the network has no gateway to the outside, so the container has no
 *     route off the host (see /egress).
 *
 * The only things that can talk to it are the api instances, because they are
 * the only other members of `data`.
 */

const net = require('net');
const { createLabServer } = require('../common/lab');

const PORT = Number(process.env.PORT || 7000);

const RECORDS = [
  { id: 'r-1001', region: 'ap-south-1', tier: 'data', payload: 'ledger snapshot 0x41ab' },
  { id: 'r-1002', region: 'ap-south-1', tier: 'data', payload: 'ledger snapshot 0x9f02' },
  { id: 'r-1003', region: 'eu-west-1', tier: 'data', payload: 'ledger snapshot 0xc731' },
];

let reads = 0;

createLabServer({
  service: 'vault',
  port: PORT,
  routes: {
    '/records': async (url) => {
      reads += 1;
      const region = url.searchParams.get('region');
      const records = region ? RECORDS.filter((r) => r.region === region) : RECORDS;
      return { status: 200, body: { source: 'vault', reads, count: records.length, records } };
    },

    '/record': async (url) => {
      const id = url.searchParams.get('id');
      const record = RECORDS.find((r) => r.id === id);
      if (!record) return { status: 404, body: { error: 'no such record', id } };
      reads += 1;
      return { status: 200, body: { source: 'vault', record } };
    },

    /**
     * Attempts one outbound TCP connection to a public IP. On an `internal`
     * Docker network there is no default route, so this fails — that failure
     * is the point of the endpoint.
     *
     * Reported as informational rather than asserted by the test suite: a
     * sandbox with no egress of its own would make it pass for the wrong reason.
     */
    '/egress': async () => {
      const host = '1.1.1.1';
      const port = 443;
      const started = Date.now();

      const result = await new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(3000);
        socket.once('connect', () => finish({ ok: true }));
        socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }));
        socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
        socket.connect(port, host);
      });

      return {
        status: 200,
        body: {
          from: 'vault',
          target: `${host}:${port}`,
          reachable: result.ok,
          error: result.error,
          ms: Date.now() - started,
          expectation: 'unreachable — the data network is declared internal, so it has no default route',
        },
      };
    },
  },
});
