# dsh-grafana-query — live verification note

Spec: [`2026-08-26-dsh-grafana-design.md`](2026-08-26-dsh-grafana-design.md) §11.

**Status: run once against Grafana Cloud on 2026-08-27 — 9 OK, 0 FAILED, 3 SKIP.**
L1–L8 and L10 were exercised against a real instance; L9, L11, and L12 were not run and are
recorded as unverified below with the reason. §11 also asks for a second run against a
self-hosted Grafana; that run has **not** happened, which leaves the sub-path part of L2
unexercised.

Everything not covered by a live run is still backed only by unit tests, which mock `fetch`.

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
`lib/`.

## Environment under test

| | Grafana Cloud | Self-hosted |
| --- | --- | --- |
| Instance | `https://commeet.grafana.net` (stack slug `commeet`, region `prod-ap-southeast-0`) | not run |
| `baseUrl` | `https://commeet.grafana.net/` (root path, no sub-path) | not run |
| Token type | service account `dsh-grafana-live-verify` (`sa-1-dsh-grafana-live-verify`) | not run |
| Roles granted | basic role **Viewer** + fixed role **Alerting → Full read-only access** | not run |
| Prometheus data source | `grafanacloud-prom` | not run |
| Non-Prometheus data source | `grafanacloud-logs` (Loki) | not run |
| Date run | 2026-08-27T03:28:42Z | — |
| Result | 9 OK / 0 FAILED / 3 SKIP | — |

## Results

`VERIFIED` — exercised live and matched the expectation. `NOT VERIFIED` — not exercised;
the reason is recorded. The **Not covered** column is what the run did *not* reach, even
where the status is `VERIFIED`.

| # | Assumption | Status | Observed (Grafana Cloud, 2026-08-27) | Not covered |
| --- | --- | --- | --- | --- |
| L1 | The uid proxy path works and returns native Prometheus JSON, not a dataframe | VERIFIED | `resultType=vector`, 21 series for `up`. Native Prometheus shape, no dataframe wrapper | Self-hosted |
| L2 | A sub-path `baseUrl` (`https://host/grafana/`) composes correct URLs | VERIFIED (root path only) | `baseUrl=https://commeet.grafana.net/` → `composed=https://commeet.grafana.net/api/health` | **The sub-path case itself.** Grafana Cloud serves from the root, so this run only proves root-path composition. The sub-path assumption needs the self-hosted run |
| L3 | A PromQL syntax error returns HTTP **400** with `{"status":"error","errorType":"bad_data","error":...}` | VERIFIED | `status=400 code=UPSTREAM_QUERY_FAILED errorType=bad_data`, `upstreamMessage="invalid parameter \"query\": 1:4: parse error: unclosed left parenthesis"` — the §6.2 exposure path works end to end and a real parse error reaches the agent intact | This particular message contains none of the §6.2 redaction keywords, so it does not by itself exercise the redaction pattern. That is covered by the unit tests in `tests/errors.test.ts` |
| L4 | An oversized query returns 422 (or 400), not 200 | VERIFIED | `status=422 code=UPSTREAM_QUERY_FAILED errorType=execution`. Note the `errorType` is `execution`, not `bad_data`; it is on the §6.2 whitelist, and per §6.2 no free-text `error` is exposed at 422 | — |
| L5 | Which vocabulary `/api/prometheus/grafana/api/v1/rules` uses for `state` | VERIFIED (inactive only) | `stateVocabulary=prometheus`, `counts={"firing":0,"pending":0,"inactive":19,"unknown":0}`, `unrecognized=[]`. Grafana returned the literal Prometheus word `inactive`, so no normalization was needed | **The alias path.** All 19 rules were inactive, so `alerting→firing`, `normal→inactive`, and the `unknown` + `stateRaw` fallback were never exercised live. §11 suggests creating a rule that must fire; that was not done |
| L6 | `/api/v1/provisioning/alert-rules` is readable with alerting read-only, is a top-level array, and `data[].model.expr` is the right path | VERIFIED | `total=19 queryNodes=12 withExpr=4 expressionNodes=7`. Top-level array parsed, `model.expr` path correct. The numbers confirm the fix to the `type` rule: "has no expr" and "`datasourceUid === '__expr__'`" genuinely diverge (4 ≠ 12 − 7) | — |
| L7 | Cloud `/api/datasources` volume and `grafanacloud-*` naming; `type` / `name_contains` plus paging are enough | VERIFIED | `total=26`, 14 distinct types: `alertmanager`, `cloudwatch`, `prometheus`, `stackdriver`, `googlecloud-logging-datasource`, `grafana-github-datasource`, `grafana-incident-datasource`, `loki`, `grafanacloud-cardinality-datasource`, `graphite`, `grafana-knowledgegraph-datasource`, `grafana-pyroscope-datasource`, `tempo`, `k6-datasource`. The `type` filter is what keeps this usable | — |
| L8 | What status a non-Prometheus data source returns through the proxy | VERIFIED (pre-flight only) | `status=- code=DATASOURCE_TYPE_UNSUPPORTED message=Data source grafanacloud-logs has type "loki"; this plugin only supports Prometheus-compatible data sources.` The absent status confirms the §3.3 pre-flight rejected it **without issuing the proxy request** | **The proxy's own status code.** By design the pre-flight fires first whenever metadata is readable, so the §2.3 "metadata succeeded + proxy returns 404/405" row cannot be reached this way. It is only reachable through the L12 degrade path, which was not run |
| L9 | A legacy API key and a service account token both pass `Authorization: Bearer` | NOT VERIFIED | — | Grafana 9+ has deprecated legacy API keys and this Cloud instance has none. The handling of both header forms is covered only by unit tests |
| L10 | Whether Cloud rate limits trip under normal use | VERIFIED | 20 sequential queries, `429 responses=0`. No note needed in the README, and the "no automatic retries" decision stands | Sustained or concurrent load |
| L11 | `maxResponseBytes` aborts a genuinely large response instead of running out of memory | NOT VERIFIED | — | Skipped deliberately. The bound was measured against a 1000-byte limit during review (the stream stops within one chunk of the limit), and pointing a multi-megabyte query at a production Grafana was judged not worth the load |
| L12 | A service account with `datasources:query` but not `datasources:read` gets through the §2.3 degrade path | NOT VERIFIED | — | Needs a second service account, which has not been created. This is the path that decides whether the §2.3 degrade table and the proxy 404/405 discrimination behave as designed |

## Conclusions folded back into the spec

§11 requires the measured outcomes of **L3, L5, L8, and L12** to be written back into the
matching spec sections.

- **L3 → §6.2 / §3.3 error table:** confirmed as designed. Grafana Cloud returns HTTP **400**
  with `errorType: "bad_data"` for a PromQL syntax error, and the structured `error` field
  carries a usable parse diagnostic. The §6.2 fallback ("if it returns 422, widen exposure to
  400 or 422") is **not** needed.
- **L5 → §2.4 normalization table:** the Prometheus-compatible rules endpoint returns the
  Prometheus vocabulary (`inactive` observed literally), so `meta.stateVocabulary` reports
  `prometheus` and the aliases stay dormant. No third vocabulary appeared. **Caveat:** only
  the `inactive` state occurred, so the Grafana-side aliases remain unconfirmed live.
- **L8 → §2.3 proxy 404/405 discrimination table:** unchanged, and **still unverified**. The
  §3.3 pre-flight rejects a non-Prometheus data source before any proxy request whenever
  metadata is readable, which is exactly what was observed, so this run could not produce a
  proxy status code at all. The table's "metadata succeeded" row is only reachable when a
  Prometheus data source's backend does not serve `/api/v1/query*`.
- **L12 → §2.3 metadata degrade table:** unverified. No conclusion to fold back.

## Raw output

### Grafana Cloud

```text
# dsh-grafana-query live verification - cloud
# 2026-08-27T03:28:42Z

L1   OK    resultType=vector series=21 (native Prometheus JSON, not a dataframe)
L2   OK    baseUrl=https://commeet.grafana.net/ composed=https://commeet.grafana.net/api/health
L3   OK    status=400 code=UPSTREAM_QUERY_FAILED errorType=bad_data upstreamMessage="invalid parameter \"query\": 1:4: parse error: unclosed left parenthesis"
L4   OK    status=422 code=UPSTREAM_QUERY_FAILED errorType=execution
L5   OK    stateVocabulary=prometheus counts={"firing":0,"pending":0,"inactive":19,"unknown":0} unrecognized=[]
L6   OK    total=19 queryNodes=12 withExpr=4 expressionNodes=7
L7   OK    total=26 types=["alertmanager","cloudwatch","prometheus","stackdriver","googlecloud-logging-datasource","grafana-github-datasource","grafana-incident-datasource","loki","grafanacloud-cardinality-datasource","graphite","grafana-knowledgegraph-datasource","grafana-pyroscope-datasource","tempo","k6-datasource"]
L8   OK    status=- code=DATASOURCE_TYPE_UNSUPPORTED message=Data source grafanacloud-logs has type "loki"; this plugin only supports Prometheus-compatible data sources.
L9   SKIP  set GRAFANA_LEGACY_API_KEY to run this check
L10  OK    20 sequential queries, 429 responses=0
L11  SKIP  set GRAFANA_BIG_QUERY to run this check
L12  SKIP  set GRAFANA_QUERY_ONLY_TOKEN to run this check

# 9 ok, 0 failed, 3 skipped
```

### Self-hosted

```text
not run
```

## Permission setup that was actually used

The scope names in §2.2 and in the README permission table are what Grafana checks
internally; they are not what the Grafana UI asks you to tick. The combination that worked
on Grafana Cloud on 2026-08-27:

1. Create a service account with basic role **Viewer** — this covers `datasources:read` and
   `datasources:query`.
2. Add the fixed role **Alerting → Full read-only access** — this covers `alert.rules:read`
   and `alert.provisioning:read`.

All six tools worked with exactly that. This is now documented in all four READMEs.

## Sign-off

- Run by: maxmilian
- Date: 2026-08-27
- Environments: Grafana Cloud only; self-hosted not run
- Verdict: **conditional pass.** L1–L8 and L10 behaved as designed on Grafana Cloud with no
  fallback triggered. L9, L11, and L12 remain unverified, and L2's sub-path case and L5's
  alias path were not reached by this run. Whether those four gaps block release is the
  maintainer's call; §11 as written asks for a self-hosted run as well.
