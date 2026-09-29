#!/usr/bin/env bash
# Cloud Network Lab control script.
#
#   ./scripts/lab.sh up        build and start the topology
#   ./scripts/lab.sh test      run the verification suite against it
#   ./scripts/lab.sh status    container + network state
#   ./scripts/lab.sh matrix    print the live reachability matrix
#   ./scripts/lab.sh logs      follow logs
#   ./scripts/lab.sh down      stop and remove everything
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml")
GATEWAY="${NETLAB_GATEWAY:-http://127.0.0.1:8080}"

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "error: cannot talk to the Docker daemon. Is Docker running?" >&2
    exit 1
  fi
}

case "${1:-help}" in
  up)
    require_docker
    "${COMPOSE[@]}" up -d --build
    echo
    echo "Waiting for the gateway to report healthy backends..."
    for _ in $(seq 1 60); do
      if curl -fsS "$GATEWAY/lab/backends" 2>/dev/null | grep -q '"healthy": true'; then
        echo "Lab is up.  Dashboard: $GATEWAY"
        exit 0
      fi
      sleep 1
    done
    echo "warning: backends did not report healthy in time; check './scripts/lab.sh logs'" >&2
    ;;

  down)
    require_docker
    "${COMPOSE[@]}" down -v --remove-orphans
    ;;

  test)
    node "$ROOT/tests/netlab-test.js"
    ;;

  status)
    require_docker
    echo "== containers =="
    "${COMPOSE[@]}" ps
    echo
    echo "== networks =="
    docker network ls --filter name=cloud-network-lab
    echo
    for netname in edge app data; do
      full="cloud-network-lab_${netname}"
      echo "-- $full --"
      docker network inspect "$full" \
        --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' 2>/dev/null \
        || echo "(not created)"
    done
    ;;

  matrix)
    curl -fsS "$GATEWAY/lab/matrix" | node -e '
      let raw = ""; process.stdin.on("data", c => raw += c).on("end", () => {
        const m = JSON.parse(raw);
        const pad = s => String(s).padEnd(9);
        console.log("\nreachability (rows = source, cols = target)\n");
        console.log(pad("") + m.targets.map(pad).join(""));
        for (const s of m.sources) {
          console.log(pad(s) + m.targets.map(t => pad(m.actual[s][t].ok ? "open" : "BLOCKED")).join(""));
        }
        console.log(m.mismatches.length ? "\nmismatches: " + JSON.stringify(m.mismatches, null, 2)
                                        : "\nmatches the declared topology exactly.");
      });'
    ;;

  logs)
    require_docker
    shift || true
    "${COMPOSE[@]}" logs -f "$@"
    ;;

  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
