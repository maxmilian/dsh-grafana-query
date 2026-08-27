#!/usr/bin/env bash
#
# Live verification driver for dsh-grafana-query (spec section 11, L1-L12).
#
# Read-only: it issues GET requests to Grafana and never creates, edits, or
# deletes anything, in Grafana or on disk. Every credential comes from an
# environment variable; nothing is read from a file or prompted for.
#
# Run it once against a self-hosted Grafana and once against Grafana Cloud,
# then paste the output into
# docs/superpowers/specs/2026-08-26-dsh-grafana-verification.md.
#
# Required:
#   GRAFANA_URL                       base URL, sub-path allowed
#   GRAFANA_TOKEN                     service account token
#
# Optional (the matching check is skipped, and reported as SKIP, when unset):
#   GRAFANA_DATASOURCE_UID            Prometheus data source uid       (L1 L3 L4 L10 L11)
#   GRAFANA_NON_PROM_DATASOURCE_UID   e.g. a Loki or MySQL uid         (L8)
#   GRAFANA_LEGACY_API_KEY            legacy API key                   (L9)
#   GRAFANA_QUERY_ONLY_TOKEN          token with datasources:query and
#                                     without datasources:read         (L12)
#   GRAFANA_BIG_QUERY                 PromQL returning several MB      (L11)
#   GRAFANA_LABEL                     label for this run, e.g. "cloud"
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

missing=()
[[ -n "${GRAFANA_URL:-}" ]] || missing+=(GRAFANA_URL)
[[ -n "${GRAFANA_TOKEN:-}" ]] || missing+=(GRAFANA_TOKEN)
if ((${#missing[@]})); then
  echo "smoke-dsh: missing required environment variable(s): ${missing[*]}" >&2
  echo "smoke-dsh: see the header of $0 for the full list." >&2
  exit 1
fi

# Always build first. A stale lib/ has already produced false review findings.
echo "smoke-dsh: building lib/ ..." >&2
(cd "$root" && bun run build >/dev/null)

exec node "$root/scripts/smoke-dsh.mjs"
