# dsh-grafana-query

[English](README.md) | 繁體中文 | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

`dsh-grafana-query` 是一個免費開源、**唯讀**的 DeepSeek Harness Grafana 插件。
它讓 agent 透過 Grafana 的 datasource proxy 執行 PromQL，並讀取 Grafana unified alerting
的當前狀態，全程不改動 Grafana 的任何資料。

請勿與 npm 上的 `dsh-grafana` 混淆——那是一個**寫入型的 dashboard 編輯器**，會把 dashboard JSON
推回 Grafana。本插件做的是相反的事：唯讀的指標查詢與告警狀態。dashboard 與 panel JSON 明確不在範圍內。

## Tools

| 工具 | 用途 |
| --- | --- |
| `grafana_health` | 確認實例可連線並回報版本。 |
| `grafana_list_datasources` | 列出 datasource 的 uid、type 與 access 模式。請先呼叫這個。 |
| `grafana_query` | 透過 datasource proxy 執行 instant PromQL 查詢。 |
| `grafana_query_range` | 執行區間 PromQL 查詢，強制套用 step 與點數上限。 |
| `grafana_alert_state` | 讀取 unified alerting 規則的當前狀態。 |
| `grafana_list_alert_rules` | 列出已佈建的告警規則定義。 |

所有工具皆為唯讀。v0.1 不會在 Grafana 建立、修改、刪除、silence、ack 或暫停任何東西。

## 硬性上限

以下上限都由插件本身強制，與 Grafana 無關。任何一處被截斷時，`meta.truncated` 與截斷前的總數都會標示出來。

| 項目 | 值 |
| --- | --- |
| 每條 series 的點數（`max_points`） | 預設 200、上限 500。Prometheus 兩端都會回傳，因此 `n` 秒的區間搭配 step `s` 會得到 `floor(n / s) + 1` 個點 |
| 區間長度（`grafana_query_range`） | 31 天 |
| 單次區間查詢的總點數 | 20000；超過的 series 會被整條捨棄，不會砍半截 |
| 單次查詢的 series 數 | `maxSeries`，預設 100 |
| 告警規則筆數（`grafana_alert_state`、`grafana_list_alert_rules`） | 符合條件的前 500 筆；其餘無法靠翻頁取得，請用篩選參數 |
| 每條規則的告警 instance | 預設 10、上限 50 |
| 每頁筆數 | 預設 20、上限 100 |
| 上游錯誤文字 | 200 字元，且僅 HTTP 400 才透出 |

`grafana_alert_state` 預設只回傳 `firing`、`pending` 與 `unknown` 的規則——**`inactive` 規則預設不會出現**，
需要時請用 `state` 明確指定。

## Requirements

- 具備相容 `@deepseek-ai/dsh-tools` API 的 DeepSeek Harness
- Node.js 22.19 以上（22.x 系列）或 Node.js 24 以上
- **Grafana 9.0 以上**——只支援 uid 版 datasource proxy（`/api/datasources/proxy/uid/:uid/*`），
  不支援已 deprecated 的數字 id 路徑

## Configuration

```sh
export GRAFANA_URL='https://grafana.example.com'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

| 欄位 | 環境變數 | 預設 | 範圍 |
| --- | --- | --- | --- |
| `baseUrl` | `GRAFANA_URL` | 必填 | http(s) URL，不可內嵌帳密、不可帶 query 或 fragment；可含 sub-path |
| `token` | `GRAFANA_TOKEN` | 必填 | 不可為空 |
| `locale` | — | `en` | `en`、`zh-TW`、`zh-CN`、`ja` |
| `requestTimeoutMs` | — | `30000` | 1 – 300000 |
| `maxResponseBytes` | — | `5242880` | 1 – 52428800 |
| `maxSeries` | — | `100` | 1 – 1000 |

plugin 設定的優先權高於環境變數。

## Permissions

Grafana service account token（建議）與舊版 API key 都可以用——兩者都走同一個
`Authorization: Bearer` header。Grafana Cloud 的 Access Policy token（`glc_`）是給 Cloud
資料端點用的，**不適用**於這個 API。

### 實際在 Grafana 上怎麼設

下表的 scope 名稱是 Grafana 內部檢查用的，**UI 上並不是這樣勾**。建立 service account 時可行的組合是：

1. basic role 選 **Viewer**——涵蓋 `datasources:read` 與 `datasources:query`。
2. 再加 fixed role **Alerting → Full read-only access**——涵蓋 `alert.rules:read` 與
   `alert.provisioning:read`。

已於 2026-08-27 在 Grafana Cloud 用這個組合實測，六個工具全部可用。
詳見[驗證紀錄](docs/superpowers/specs/2026-08-26-dsh-grafana-verification.md)。

**用最小權限的 token 不會讓工具變難用**：Grafana 對 `GET /api/datasources` 是**回傳過濾後的列表**，
而不是回 403。因此只被授予單一 datasource **Query** 權限的 token，`grafana_list_datasources`
就只會列出那一個——2026-08-27 實測：Viewer token 拿到 26 筆，受限 token 拿到 1 筆。你不會看到一堆
查下去就 403 的項目。（datasource 層級的 Query 權限也隱含允許讀該 datasource 的 metadata，
因此不存在「查得動但讀不到」的狀態。）

### Scope 對照

| 工具 | 所需權限 |
| --- | --- |
| `grafana_health` | 無——`/api/health` 不需認證，因此本工具無法判斷 token 是否有效；要驗證 token 請用 `grafana_list_datasources`。 |
| `grafana_list_datasources` | `datasources:read` |
| `grafana_query`、`grafana_query_range` | `datasources:query`（另有 `datasources:read` 才能做前置型別檢查） |
| `grafana_alert_state` | `alert.rules:read` |
| `grafana_list_alert_rules` | `alert.provisioning:read` |

## Grafana Cloud

`baseUrl` 指向 stack 本身，並使用在該 stack 建立的 service account token：

```sh
export GRAFANA_URL='https://your-stack.grafana.net'
export GRAFANA_TOKEN='glsa_your_service_account_token'
```

這裡不要用 `glc_` 開頭的 Access Policy token。Cloud stack 內建大量 datasource，
請善用 `grafana_list_datasources` 的 `type` 與 `name_contains` 篩選以縮短清單。

## Install

```sh
bun add dsh-grafana-query
```

套件內含 `cordis.patch.yml`，並透過 `package.json` 的 `dsh.bundle.patch` 宣告，
讓 DeepSeek Harness registry 能以預設設定載入本插件。

## Examples

1. `grafana_list_datasources` 帶 `{"type": "prometheus"}` 取得 uid。
2. `grafana_query` 帶 `{"datasource_uid": "prom-1", "query": "up"}` 查當前值。
3. `grafana_query_range` 帶 `{"datasource_uid": "prom-1", "query": "rate(node_cpu_seconds_total[5m])", "start": "...", "end": "..."}`
   查走勢。省略 `step` 時插件會自動挑一個，讓每條 series 的點數不超過 `max_points`。
4. `grafana_alert_state` 不帶參數，看現在有什麼在燒。

## Internationalization

把 `locale` 設為 `en`、`zh-TW`、`zh-CN` 或 `ja`，可切換模型看到的工具與參數描述。
工具名稱一律維持英文，錯誤訊息也一律是英文。

## Security and error behavior

- 每個工具都是唯讀。
- 錯誤永遠不會夾帶 token、`Authorization` header 或原始 response body。
- 唯一的例外：當 Prometheus 以 HTTP 400 拒絕查詢時，會把結構化的 `error` 欄位透出，
  讓 agent 能修正自己的 PromQL。上限 200 字元，且事前會先跑一次機密過濾。
  其他狀態碼一律回傳靜態訊息。
- 回應大小受 `maxResponseBytes`、`maxSeries` 以及每條 series 的點數上限三重限制。
  任何裁剪都會在 `meta.truncated` 與裁剪前的總數留下記錄。

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
