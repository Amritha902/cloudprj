# Cloud Network Lab

A small, runnable cloud networking project: a three-tier private network built
with Docker networks, a load-balanced application tier, an isolated data tier,
and a test suite that **measures** whether the isolation actually holds instead
of assuming it.

Everything in it is free and open source. No cloud account, no paid tier, no
npm dependencies.

```
                        host  127.0.0.1:8080
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        │  edge  172.28.0.0/24    │   published to the host  │
        │                     ┌───┴────┐                     │
        │                     │gateway │                     │
        └─────────────────────┴───┬────┴─────────────────────┘
                          ┌───────┴───────┐            ╎
        ┌─────────────────┼───────────────┼────────────╎─────┐
        │  app  172.28.1.0/24         private          ╎     │
        │             ┌───┴───┐     ┌───┴───┐          ╎     │
        │             │ api-1 │     │ api-2 │       ✕ blocked│
        └─────────────┴───┬───┴─────┴───┬───┴──────────╎─────┘
                          └───────┬─────┘              ╎
        ┌─────────────────────────┼────────────────────╎─────┐
        │  data  172.28.2.0/24   internal: no route out ╎    │
        │                     ┌───┴────┐                     │
        │                     │ vault  │←───────────────────╌┘
        └─────────────────────┴────────┘
```

The gateway is **not** attached to the `data` network. It cannot reach the
vault — Docker's embedded DNS will not even resolve the name for it. Only the
api tier bridges `app` and `data`, so every request for data has to go through
the application tier. That is the property the lab exists to demonstrate.

---

## Quick start

Requires Docker (with Compose v2) and Node 18+ on the host. Nothing else.

```bash
git clone https://github.com/Amritha902/cloudprj.git
cd cloudprj

./scripts/lab.sh up        # build and start the four containers
./scripts/lab.sh test      # run the verification suite
open http://127.0.0.1:8080 # the live dashboard
./scripts/lab.sh down      # tear it all down
```

`npm run up` / `npm test` / `npm run down` do the same thing.

---

## What it demonstrates

Each of these is a cloud networking concept you would otherwise pay a provider
to show you, mapped onto its managed equivalent:

| Concept in the lab | Managed equivalent |
|---|---|
| Three bridge networks with fixed CIDRs | VPC subnets (AWS/GCP/Azure) |
| Only `gateway` publishes a host port | Public subnet + internet-facing load balancer |
| `app` tier with no published port | Private subnet |
| `data` network with `internal: true` | Isolated subnet with no NAT gateway / no egress |
| Service-name reachability only across shared networks | Security groups / network ACLs |
| Docker embedded DNS resolving `vault`, `api-1`, … | Cloud DNS / service discovery |
| Gateway round-robin over healthy backends | ALB / target group with health checks |
| Backend drops out of rotation when it dies | Health-check-driven failover |

---

## The reachability matrix

The interesting part. `services/common/lab.js` declares the topology once, and
the rule that follows from it: **two services can reach each other only if they
share a network.** The gateway then measures reality — it probes its own row
directly, and asks each api instance to probe on its behalf — and compares.

```
reachability (rows = source, cols = target)

         gateway  api-1    api-2    vault
gateway  open     open     open     BLOCKED
api-1    open     open     open     open
api-2    open     open     open     open

matches the declared topology exactly.
```

Every cell is a real TCP connect from inside the source container, not a lookup
table. `./scripts/lab.sh matrix` prints it; the dashboard renders it live and
outlines any cell that disagrees with the declaration.

---

## What the test suite checks

`./scripts/lab.sh test` runs 18 assertions against the live containers:

```
Ingress — only the gateway is published
  PASS  gateway answers on the published port
  PASS  gateway serves the dashboard at /
  PASS  api tier is not published on the host loopback (127.0.0.1:4000)
  PASS  vault tier is not published on the host loopback (127.0.0.1:7000)

Load balancing — round-robin across the application tier
  PASS  all 8 proxied requests succeeded
        X-Served-By sequence: api-1 api-2 api-1 api-2 api-1 api-2 api-1 api-2
  PASS  traffic is spread over both api instances

End-to-end path — edge -> app -> data
  PASS  gateway -> api -> vault returns data from the isolated tier
        hops=gateway (edge) -> api-1 (app) -> vault (data)
  PASS  the response really came from the vault

Segmentation — measured reachability vs the declared topology
  PASS  gateway cannot reach the vault (no shared network)
        gateway -> vault:7000 -> ENOTFOUND
  PASS  api-1 can reach the vault (shares the data network)
  PASS  api-2 can reach the vault (shares the data network)
  PASS  gateway can reach both api instances (shares the app network)
  PASS  every measured edge matches the declared topology

Service discovery — Docker embedded DNS
  PASS  api-1 resolves the name "vault" to an address in the data subnet
        vault -> 172.28.2.2
  PASS  the same name does not resolve from the gateway
        gateway resolving "vault" -> ENOTFOUND

Failover — health checks drop a dead instance out of rotation
  PASS  requests keep succeeding with api-2 stopped
  PASS  all traffic shifts to the surviving instance
  PASS  api-2 rejoins the rotation after restart

  18 passed, 0 failed
```

The failover case genuinely stops `api-2` mid-suite, confirms every subsequent
request is served by `api-1` with no 5xx, then restarts it and waits for it to
rejoin.

### Watch failover by hand

```bash
docker compose stop api-2     # then click "Send 10 requests" on the dashboard
docker compose start api-2    # it rejoins within one health-check interval
```

---

## Honest limits

Worth knowing, because a demo that overclaims teaches the wrong thing:

- **The Docker host can reach every container directly.** The bridges belong to
  the host kernel, so from the host `172.28.2.2:7000` reaches the vault even
  though no port is published. The isolation demonstrated here is *between
  tiers*, not from the machine running Docker. In a real VPC the equivalent
  boundary is enforced by the hypervisor and the provider's network fabric.
- **Docker bridge networks are bidirectional.** `api-1` can reach `vault` and
  `vault` can reach `api-1`. One-way rules need firewall policy (iptables,
  Cilium, a service mesh), not network membership.
- **The vault's egress check is informational.** `internal: true` really does
  leave it with no default route (`ENETUNREACH`), but a sandbox that has no
  outbound access of its own would pass that check for the wrong reason, so the
  suite reports it without asserting on it.
- **`/probe` is restricted to declared lab services on their declared ports.**
  An unrestricted version would be an open port scanner for anything the
  container can route to.

---

## Endpoints

Through the gateway on `127.0.0.1:8080`:

| Path | What it does |
|---|---|
| `/` | Dashboard |
| `/health` | Gateway liveness |
| `/lab/topology` | Declared topology + expected reachability |
| `/lab/backends` | Backend health, request counts, latency |
| `/lab/matrix` | Live reachability matrix with mismatches |
| `/lab/egress` | Vault's egress self-check, relayed through the api tier |
| `/dns?name=vault` | DNS resolution *as the gateway sees it* (fails, by design) |
| `/api/*` | Round-robin proxied to the app tier, tagged `X-Served-By` |
| `/api/records` | Full path: edge → app → data |
| `/api/whoami` | Which instance served you |
| `/api/dns?name=vault` | DNS resolution as an api instance sees it (succeeds) |

---

## Layout

```
cloudprj/
├── LICENSE                     MIT
├── .github/workflows/verify.yml   CI: stands the topology up and verifies it
├── docker-compose.yml          the topology: 3 networks, 4 services
├── Dockerfile                  one image, three roles
├── services/
│   ├── common/lab.js           topology definition, probes, base server
│   ├── gateway/server.js       proxy, health checks, matrix builder
│   ├── api/server.js           application tier
│   └── vault/server.js         data tier
├── public/index.html           dashboard (no external assets)
├── tests/netlab-test.js        the 18 assertions
└── scripts/lab.sh              up / down / test / status / matrix / logs
```

Every service uses only the Node standard library. There is no `npm install`,
no lockfile, and no third-party code in the image.

---

## Running it somewhere free

It is four small containers, so it fits comfortably in free tiers:

- **GitHub Codespaces** — free monthly hours; Docker is preinstalled. Clone, run
  `./scripts/lab.sh up`, open the forwarded port 8080.
- **GitHub Actions** — free for public repos. `.github/workflows/verify.yml`
  builds the topology and runs the suite on every push.
- **Play with Docker** (`labs.play-with-docker.com`) — free 4-hour sessions.
- **Oracle Cloud Always Free** — a permanently free ARM VM; install Docker and run it.
- **Fly.io / Render free tiers** — for the gateway; note these platforms give
  you their own networking model, so the multi-network topology is best kept on
  a single VM or in Codespaces.

To expose it beyond loopback on a VM, change the gateway's port mapping in
`docker-compose.yml` from `127.0.0.1:8080:8080` to `8080:8080` — deliberately,
since that puts it on the machine's network.

### If your environment cannot pull from a public registry

The Dockerfile takes a `BASE_IMAGE` build argument, so you can point it at any
base you already have locally:

```bash
NETLAB_BASE_IMAGE=my-local-node-base:tag ./scripts/lab.sh up
```

The default is `node:22-alpine`, which is what you want anywhere with normal
registry access.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `pool overlaps with other one` on `up` | Another network already uses `172.28.x.0/24`. Change the subnets in `docker-compose.yml`. |
| Suite says "gateway never reported two healthy backends" | The lab is not up, or still starting. `./scripts/lab.sh logs`. |
| `port is already allocated` | Something else holds 8080. Change the gateway's published port. |
| Failover assertions skipped | The `docker` CLI is not on the host running the tests. |

---

## Licence

[MIT](LICENSE) © 2026 Amritha S.
