# dsh-grafana-query

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文 | [日本語](README.ja.md)

`dsh-grafana-query` 是一个免费开源、**只读**的 DeepSeek Harness Grafana 插件。
它让 agent 通过 Grafana 的 datasource proxy 执行 PromQL，并读取 Grafana unified alerting
的当前状态，全程不改动 Grafana 的任何数据。

请勿与 npm 上的 `dsh-grafana` 混淆——那是一个**写入型的 dashboard 编辑器**，会把 dashboard JSON
推回 Grafana。本插件做的是相反的事：只读的指标查询与告警状态。dashboard 与 panel JSON 明确不在范围内。

## Tools

| 工具 | 用途 |
| --- | --- |
| `grafana_health` | 确认实例可连接并返回版本。 |
| `grafana_list_datasources` | 列出 datasource 的 uid、type 与 access 模式。请先调用这个。 |
| `grafana_query` | 通过 datasource proxy 执行 instant PromQL 查询。 |
| `grafana_query_range` | 执行区间 PromQL 查询，强制套用 step 与点数上限。 |
| `grafana_alert_state` | 读取 unified alerting 规则的当前状态。 |
| `grafana_list_alert_rules` | 列出已配置的告警规则定义。 |

所有工具均为只读。v0.1 不会在 Grafana 创建、修改、删除、silence、ack 或暂停任何东西。

## 硬性上限

以下上限均由插件本身强制，与 Grafana 无关。任何一处被截断时，`meta.truncated` 与截断前的总数都会标示出来。

| 项目 | 值 |
| --- | --- |
| 每条 series 的点数（`max_points`） | 默认 200、上限 500。Prometheus 两端都会返回，因此 `n` 秒的区间搭配 step `s` 会得到 `floor(n / s) + 1` 个点 |
| 区间长度（`grafana_query_range`） | 31 天 |
| 单次区间查询的总点数 | 20000；超出的 series 会被整条丢弃，不会砍成半截 |
| 单次查询的 series 数 | `maxSeries`，默认 100 |
| 告警规则条数（`grafana_alert_state`、`grafana_list_alert_rules`） | 匹配条件的前 500 条；其余无法通过翻页获取，请用筛选参数 |
| 每条规则的告警 instance | 默认 10、上限 50 |
| 每页条数 | 默认 20、上限 100 |
| 上游错误文本 | 200 字符，且仅 HTTP 400 才透出 |

`grafana_alert_state` 默认只返回 `firing`、`pending` 与 `unknown` 的规则——**`inactive` 规则默认不会出现**，
需要时请用 `state` 明确指定。

## Requirements

- 具备兼容 `@deepseek-ai/dsh-tools` API 的 DeepSeek Harness
- Node.js 22.19 以上（22.x 系列）或 Node.js 24 以上
- **Grafana 9.0 以上**——只支持 uid 版 datasource proxy（`/api/datasources/proxy/uid/:uid/*`），
  不支持已 deprecated 的数字 id 路径

## Configuration

```sh
export GRAFANA_URL='https://grafana.example.com'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

| 字段 | 环境变量 | 默认 | 范围 |
| --- | --- | --- | --- |
| `baseUrl` | `GRAFANA_URL` | 必填 | http(s) URL，不可内嵌账号密码、不可带 query 或 fragment；可含 sub-path |
| `token` | `GRAFANA_TOKEN` | 必填 | 不可为空 |
| `locale` | — | `en` | `en`、`zh-TW`、`zh-CN`、`ja` |
| `requestTimeoutMs` | — | `30000` | 1 – 300000 |
| `maxResponseBytes` | — | `5242880` | 1 – 52428800 |
| `maxSeries` | — | `100` | 1 – 1000 |

plugin 配置的优先级高于环境变量。

## Permissions

Grafana service account token（推荐）与旧版 API key 都可以用——两者都走同一个
`Authorization: Bearer` header。Grafana Cloud 的 Access Policy token（`glc_`）是给 Cloud
数据端点用的，**不适用**于这个 API。

| 工具 | 所需权限 |
| --- | --- |
| `grafana_health` | 无——`/api/health` 不需要认证，因此本工具无法判断 token 是否有效；要验证 token 请用 `grafana_list_datasources`。 |
| `grafana_list_datasources` | `datasources:read` |
| `grafana_query`、`grafana_query_range` | `datasources:query`（另有 `datasources:read` 才能做前置类型检查） |
| `grafana_alert_state` | `alert.rules:read` |
| `grafana_list_alert_rules` | `alert.provisioning:read` |

## Grafana Cloud

`baseUrl` 指向 stack 本身，并使用在该 stack 创建的 service account token：

```sh
export GRAFANA_URL='https://your-stack.grafana.net'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

这里不要用 `glc_` 开头的 Access Policy token。Cloud stack 内置大量 datasource，
请善用 `grafana_list_datasources` 的 `type` 与 `name_contains` 筛选以缩短列表。

## Install

```sh
bun add dsh-grafana-query
```

包内含 `cordis.patch.yml`，并通过 `package.json` 的 `dsh.bundle.patch` 声明，
让 DeepSeek Harness registry 能以默认配置加载本插件。

## Examples

1. `grafana_list_datasources` 带 `{"type": "prometheus"}` 获取 uid。
2. `grafana_query` 带 `{"datasource_uid": "prom-1", "query": "up"}` 查当前值。
3. `grafana_query_range` 带 `{"datasource_uid": "prom-1", "query": "rate(node_cpu_seconds_total[5m])", "start": "...", "end": "..."}`
   查趋势。省略 `step` 时插件会自动挑一个，使每条 series 的点数不超过 `max_points`。
4. `grafana_alert_state` 不带参数，看现在有什么在告警。

## Internationalization

把 `locale` 设为 `en`、`zh-TW`、`zh-CN` 或 `ja`，可切换模型看到的工具与参数描述。
工具名称一律保持英文，错误信息也一律是英文。

## Security and error behavior

- 每个工具都是只读。
- 错误永远不会夹带 token、`Authorization` header 或原始 response body。
- 唯一的例外：当 Prometheus 以 HTTP 400 拒绝查询时，会把结构化的 `error` 字段透出，
  让 agent 能修正自己的 PromQL。上限 200 字符，且事前会先跑一次敏感信息过滤。
  其他状态码一律返回静态信息。
- 响应大小受 `maxResponseBytes`、`maxSeries` 以及每条 series 的点数上限三重限制。
  任何裁剪都会在 `meta.truncated` 与裁剪前的总数留下记录。

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
