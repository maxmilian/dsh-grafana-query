# dsh-grafana-query

English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

`dsh-grafana-query` is a free, open-source, **read-only** DeepSeek Harness plugin for Grafana.
It lets an agent run PromQL through Grafana's data source proxy and read the state of
Grafana unified alerting, without changing anything in Grafana.

Not to be confused with `dsh-grafana` on npm, which is a **dashboard editor** that writes
dashboard JSON back to Grafana. This plugin does the opposite job: read-only metric queries
and alert state. Dashboard and panel JSON are explicitly out of scope.

## Tools

| Tool | Purpose |
| --- | --- |
| `grafana_health` | Check that the instance is reachable and report its version. |
| `grafana_list_datasources` | List data sources with uid, type, and access mode. Run this first. |
| `grafana_query` | Run an instant PromQL query through the data source proxy. |
| `grafana_query_range` | Run a range PromQL query with an enforced step and point budget. |
| `grafana_alert_state` | Read the current state of unified alerting rules. |
| `grafana_list_alert_rules` | List provisioned alert rule definitions. |

All tools are read-only. Version 0.1 never creates, edits, deletes, silences, acknowledges,
or pauses anything in Grafana.

## Requirements

- DeepSeek Harness with compatible `@deepseek-ai/dsh-tools` APIs
- Node.js 22.19 or newer in the 22.x line, or Node.js 24 or newer
- **Grafana 9.0 or newer** — only the uid data source proxy (`/api/datasources/proxy/uid/:uid/*`)
  is supported; the deprecated numeric-id path is not

## Configuration

```sh
export GRAFANA_URL='https://grafana.example.com'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

| Field | Environment variable | Default | Range |
| --- | --- | --- | --- |
| `baseUrl` | `GRAFANA_URL` | required | HTTP(S) URL, no credentials, no query or fragment; a sub-path is fine |
| `token` | `GRAFANA_TOKEN` | required | non-empty |
| `locale` | — | `en` | `en`, `zh-TW`, `zh-CN`, `ja` |
| `requestTimeoutMs` | — | `30000` | 1 – 300000 |
| `maxResponseBytes` | — | `5242880` | 1 – 52428800 |
| `maxSeries` | — | `100` | 1 – 1000 |

Plugin configuration takes precedence over the environment variables.

## Permissions

A Grafana service account token (recommended) or a legacy API key both work — they use the
same `Authorization: Bearer` header. A Grafana Cloud Access Policy token (`glc_`) is for the
Cloud data endpoints and does **not** work with this API.

| Tool | Required permission |
| --- | --- |
| `grafana_health` | none — `/api/health` needs no authentication, so this tool cannot tell you whether the token is valid. Use `grafana_list_datasources` for that. |
| `grafana_list_datasources` | `datasources:read` |
| `grafana_query`, `grafana_query_range` | `datasources:query` (plus `datasources:read` for pre-flight type checks) |
| `grafana_alert_state` | `alert.rules:read` |
| `grafana_list_alert_rules` | `alert.provisioning:read` |

## Grafana Cloud

Point `baseUrl` at the stack itself and use a service account token created in that stack:

```sh
export GRAFANA_URL='https://your-stack.grafana.net'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

Do not use a `glc_` Access Policy token here. Cloud stacks ship many built-in data sources,
so use the `type` and `name_contains` filters of `grafana_list_datasources` to keep the list short.

## Install

```sh
bun add dsh-grafana-query
```

The package ships `cordis.patch.yml`, declared through `dsh.bundle.patch` in `package.json`,
so the DeepSeek Harness registry can load the plugin with its default configuration.

## Examples

1. `grafana_list_datasources` with `{"type": "prometheus"}` to find the uid.
2. `grafana_query` with `{"datasource_uid": "prom-1", "query": "up"}` for the current value.
3. `grafana_query_range` with `{"datasource_uid": "prom-1", "query": "rate(node_cpu_seconds_total[5m])", "start": "...", "end": "..."}`
   for the trend. Omit `step` and the plugin picks one so each series stays within `max_points`.
4. `grafana_alert_state` with no arguments to see what is firing right now.

## Internationalization

Set `locale` to `en`, `zh-TW`, `zh-CN`, or `ja` to change the tool and parameter descriptions the
model sees. Tool names always stay in English, and error messages are always in English.

## Security and error behavior

- Every tool is read-only.
- Errors never contain the token, the `Authorization` header, or a raw response body.
- The single exception: when Prometheus rejects a query with HTTP 400, the structured `error`
  field is passed through so the agent can fix its PromQL. It is capped at 200 characters and
  runs through a redaction pass first. Every other status code returns a static message.
- Responses are bounded by `maxResponseBytes`, `maxSeries`, and a per-series point budget.
  Whenever anything is trimmed, `meta.truncated` and the pre-truncation totals say so.

## Development

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

## License

MIT
