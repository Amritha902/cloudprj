'use strict';

/**
 * api — the application tier. Two identical instances run behind the gateway.
 *
 * Attached to `app` (so the gateway can reach it) and `data` (so it can reach
 * the vault). It is the only tier that bridges those two networks, which is
 * what makes the vault reachable by the application but not by the edge.
 *
 * Instances are identical, so both are built from this one file and told apart
 * only by SERVICE_NAME.
 */

const { createLabServer, httpGetJSON } = require('../common/lab');

const PORT = Number(process.env.PORT || 4000);
const SERVICE_NAME = process.env.SERVICE_NAME || 'api-1';
const VAULT_URL = process.env.VAULT_URL || 'http://vault:7000';

let servedRequests = 0;

createLabServer({
  service: SERVICE_NAME,
  port: PORT,
  routes: {
    /**
     * The end-to-end path the whole topology exists to serve:
     * host -> gateway (edge) -> api (app) -> vault (data).
     */
    '/records': async (url) => {
      servedRequests += 1;
      const region = url.searchParams.get('region');
      const query = region ? `?region=${encodeURIComponent(region)}` : '';

      try {
        const upstream = await httpGetJSON(`${VAULT_URL}/records${query}`);
        return {
          status: 200,
          body: {
            servedBy: SERVICE_NAME,
            servedRequests,
            upstream: VAULT_URL,
            hops: ['gateway (edge)', `${SERVICE_NAME} (app)`, 'vault (data)'],
            count: upstream.body.count,
            records: upstream.body.records,
          },
        };
      } catch (err) {
        return {
          status: 502,
          body: { servedBy: SERVICE_NAME, error: `vault unreachable: ${err.message}` },
        };
      }
    },

    '/stats': async () => ({
      status: 200,
      body: { service: SERVICE_NAME, servedRequests },
    }),

    /**
     * Relays the vault's egress self-check. The gateway cannot call the vault
     * directly — that is the whole point — so it asks an api instance instead.
     */
    '/vault-egress': async () => {
      try {
        const upstream = await httpGetJSON(`${VAULT_URL}/egress`, 6000);
        return { status: 200, body: { relayedBy: SERVICE_NAME, ...upstream.body } };
      } catch (err) {
        return { status: 502, body: { relayedBy: SERVICE_NAME, error: `vault unreachable: ${err.message}` } };
      }
    },
  },
});
