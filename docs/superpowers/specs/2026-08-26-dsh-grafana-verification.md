# dsh-grafana-query — live verification note

Spec: [`2026-08-26-dsh-grafana-design.md`](2026-08-26-dsh-grafana-design.md) §11.
All 160+ unit tests mock `fetch`, so the assumptions below about **Grafana's actual
behaviour** are unverified until this note is filled in. §11 marks every row as
mandatory, not optional.

## How to run

```sh
export GRAFANA_URL='https://grafana.example.com'      # required
export GRAFANA_TOKEN='glsa_...'                       # required
export GRAFANA_DATASOURCE_UID='prom-1'                # L1 L3 L4 L10 L11 L12
export GRAFANA_NON_PROM_DATASOURCE_UID='loki-1'       # L8
export GRAFANA_LEGACY_API_KEY='eyJ...'                # L9
export GRAFANA_QUERY_ONLY_TOKEN='glsa_...'            # L12
export GRAFANA_BIG_QUERY='{__name__=~".+"}'           # L11
export GRAFANA_LABEL='self-hosted'                    # or 'cloud'

./scripts/smoke-dsh.sh
```

The script is read-only, takes every credential from the environment, exits 1 when a
required one is missing, and runs `bun run build` first so it can never probe a stale
`lib/`. Run it once against the self-hosted Grafana and once against Grafana Cloud, then
paste each run's output into [Raw output](#raw-output) and fill in the tables.

Environment under test:

| | Self-hosted | Grafana Cloud |
| --- | --- | --- |
| Grafana version | _to fill_ | _to fill_ |
| `baseUrl` | _to fill_ | _to fill_ |
| Token type | _to fill_ | _to fill_ |
| Date run | _to fill_ | _to fill_ |

## Results

Status values: `PASS` (matches the expectation), `FAIL` (does not — apply the spec's
fallback), `SKIP` (not exercised, say why).

| # | Assumption | Expected | Self-hosted | Cloud | Status | Fallback if it fails |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | The uid proxy path works and returns native Prometheus JSON, not a dataframe | `resultType=vector`, `result[].value` present | _to fill_ | _to fill_ | _to fill_ | Cloud-only failure → record as a README limitation, do not change the design |
| L2 | A sub-path `baseUrl` (`https://host/grafana/`) composes correct URLs | `composed=` ends in `/grafana/api/health` | _to fill_ | _to fill_ | _to fill_ | Fix `normalizeBaseUrl` or the endpoint join |
| L3 | A PromQL syntax error returns HTTP **400** with `{"status":"error","errorType":"bad_data","error":...}` | `status=400 code=UPSTREAM_QUERY_FAILED errorType=bad_data`, `upstreamMessage` non-null | _to fill_ | _to fill_ | _to fill_ | 422 instead of 400 → widen §6.2 exposure to "400 or 422" and update spec plus tests |
| L4 | An oversized query returns 422 (or 400), not 200 | `status=422` or `400` | _to fill_ | _to fill_ | _to fill_ | Adjust the `UPSTREAM_QUERY_FAILED` status mapping to what was observed |
| L5 | Which vocabulary `/api/prometheus/grafana/api/v1/rules` uses for `state` | `stateVocabulary` correct, `unrecognized=[]` | _to fill_ | _to fill_ | _to fill_ | A third vocabulary appears → add it to the normalization table, otherwise it falls to `unknown` |
| L6 | `/api/v1/provisioning/alert-rules` is readable with `alert.provisioning:read`, is a top-level array, and `data[].model.expr` is the right path | `withExpr > 0`, `expressionNodes` counts only `__expr__` nodes | _to fill_ | _to fill_ | _to fill_ | Different `expr` path → adjust the §3.6 summary; different permission name → fix the error message and the README table |
| L7 | Cloud `/api/datasources` volume and `grafanacloud-*` naming; `type` / `name_contains` plus paging are enough | `total` and `types` plausible | _to fill_ | _to fill_ | _to fill_ | Not enough filters → add more in v0.2; the cache needs no tuning |
| L8 | What status a non-Prometheus data source returns through the proxy | `code=DATASOURCE_TYPE_UNSUPPORTED` from the pre-flight check | _to fill_ | _to fill_ | _to fill_ | Add the observed status to the §2.3 table |
| L9 | A legacy API key and a service account token both pass `Authorization: Bearer` | `legacy API key accepted` | _to fill_ | _to fill_ | _to fill_ | Legacy key rejected → README says service account tokens only |
| L10 | Whether Cloud rate limits trip under normal use | `429 responses=0` | _to fill_ | _to fill_ | _to fill_ | Trips easily → note it in the README; no automatic retries |
| L11 | `maxResponseBytes` aborts a genuinely large response instead of running out of memory | `code=RESPONSE_TOO_LARGE`, small `heapGrowth` | _to fill_ | _to fill_ | _to fill_ | Adjust the streaming reader |
| L12 | A service account with `datasources:query` but not `datasources:read` gets through the §2.3 degrade path | query succeeds, `metadataRequests=1` | _to fill_ | _to fill_ | _to fill_ | Grafana forbids that combination → simplify §2.3 and throw `PERMISSION_DENIED` on 403 |

## Conclusions to fold back into the spec

§11 requires the measured outcomes of **L3, L5, L8, and L12** to be written back into the
matching spec sections.

- L3 → §6.2 / §3.3 error table: _to fill_
- L5 → §2.4 normalization table: _to fill_
- L8 → §2.3 proxy 404/405 discrimination table: _to fill_
- L12 → §2.3 metadata degrade table: _to fill_

## Raw output

### Self-hosted

```text
paste the ./scripts/smoke-dsh.sh output here
```

### Grafana Cloud

```text
paste the ./scripts/smoke-dsh.sh output here
```

## Sign-off

Release is blocked until every row above is `PASS` or has a recorded, applied fallback.

- Run by: _to fill_
- Date: _to fill_
- Verdict: _to fill_
