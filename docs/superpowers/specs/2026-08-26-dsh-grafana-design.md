# dsh-grafana 設計 spec

- 日期：2026-08-26
- 套件名（npm，unscoped）：`dsh-grafana`
- GitHub：`maxmilian/dsh-grafana`（npm 帳號 `maxhsu`）
- 授權：MIT
- 狀態：**設計已定案**（決策見 §12）。本輪不寫任何程式碼。
- 骨架來源：`dsh-sonarqube`（七檔約 950 行，唯讀插件標準形）、`dsh-forge`（工具數較多、tool metadata 四語）

---

## 1. 目的與差異化定位

`dsh-grafana` 是 DeepSeek Harness 的**唯讀** Grafana 插件，讓 agent 能在對話中直接問「現在 CPU 多少」「這兩小時記憶體怎麼走的」「哪些 alert 正在燒」，而不需要人開瀏覽器看 dashboard。

定位為 **「PromQL 查詢為主 + alert 為輔」**：

- **主軸**：透過 Grafana 的 datasource proxy，把 Grafana 當成一個「已經配置好認證與網路可達性的 Prometheus 閘道」。使用者不必再另外拿 Prometheus 的直連位址與憑證——這正是自架與 Grafana Cloud 混用時最痛的一點。
- **輔軸**：unified alerting 的「規則清單」與「當前狀態」，讓 agent 能回答「現在有什麼在 firing」。
- **差異化**：市面上多數 Grafana MCP/plugin 把重心放在 dashboard 與 panel JSON 的搜尋讀取。本插件明確**不做** dashboard/panel（見 §10 非目標）：panel JSON 又大又雜、對 agent 的訊噪比極差，且讀 panel JSON 也不等於拿到數據。我們直接給 agent 它真正要的東西——**時序數值**與**告警狀態**。
- 全部工具唯讀：不建立、不修改、不刪除任何 Grafana 資源；不 silence、不 ack alert。

### 與既有插件的一致性

沿用 `dsh-sonarqube` 的形狀：`config / errors / types / client / tools / locales / index` 七檔、統一 `OUTPUT_SCHEMA`（`data` + `meta`）、所有工具 `isConcurrencySafe: () => true`、錯誤永不帶入 token 或原始 response body（唯一刻意例外見 §6.2）。

工具數：**6 個**（`grafana_health`、`grafana_list_datasources`、`grafana_query`、`grafana_query_range`、`grafana_list_alert_rules`、`grafana_alert_state`）。

---

## 2. Grafana API 研究結論（決定實作路徑的關鍵）

### 2.1 datasource proxy：uid 版 vs 舊 id 版

| 路徑 | 狀態 |
| --- | --- |
| `GET /api/datasources/proxy/uid/:uid/*` | **Grafana 9.0 起提供，現行官方文件唯一列出的 proxy 路徑。本插件只用這個。** |
| `GET /api/datasources/proxy/:id/*` | 舊版（數字 id），Grafana 9 起已 deprecated，官方 HTTP API 文件已不再列出。**本插件不支援。** |

**已定：最低支援 Grafana 9.0，只走 uid 路徑。** README 四語都要明講；`grafana_list_datasources` 回傳的 `uid` 就是後續查詢要餵的值。

實際請求會長成：

```
GET {baseUrl}api/datasources/proxy/uid/{uid}/api/v1/query?query=...&time=...
GET {baseUrl}api/datasources/proxy/uid/{uid}/api/v1/query_range?query=...&start=...&end=...&step=...
```

即「Grafana proxy 前綴」+「Prometheus HTTP API 原路徑」。proxy 後端回傳的就是 Prometheus 原生 JSON（`{"status":"success","data":{"resultType":"vector|matrix","result":[...]}}`），不需要再解 Grafana dataframe。

### 2.2 為什麼不用 `/api/ds/query`

`POST /api/ds/query` 是 Grafana 的統一查詢入口，也能查 Prometheus。**不採用**，理由：

1. 回傳是 Grafana dataframe（`frames[].schema/data.values` 欄式陣列），要多寫一整層 decoder 才能還原成 `{metric, value}`；proxy 直接給 Prometheus 原生格式。
2. dataframe 欄位語意會隨 Grafana 版本與 datasource plugin 演進，唯讀插件不該扛這個相容性負擔。
3. Simplicity first：proxy 路徑讓 client 幾乎只是「組 URL + 轉發 + 裁剪」。

代價：proxy 需要該 datasource 的讀取權限（見 §2.5），且 `access` 模式必須是 `proxy`（server）而非 `direct`（browser）。這兩點都轉成明確錯誤（§6）。

### 2.3 非 Prometheus datasource 被指到時怎麼報錯

`grafana_list_datasources` 會回傳每個 datasource 的 `type`（`prometheus` / `loki` / `mysql` / `postgres` / …）。

策略採**兩段式**：

1. **前置檢查（cache）**：client 內部維護一份「uid → `{ type, access }`」的快取，由 `grafana_list_datasources` 或首次查詢時的 `GET {base}api/datasources/uid/{uid}` 填入，TTL 60 秒、上限 200 筆、LRU 淘汰。查詢前若查到 `type !== 'prometheus'`，直接丟 `DATASOURCE_TYPE_UNSUPPORTED`，錯誤訊息點名實際 type 與「v0.1 只支援 Prometheus 相容的 datasource」，**不發出查詢**。
2. **後置防線**：若 metadata 取得失敗（例如 service account 只有單一 datasource 的細粒度權限、拿不到 `/api/datasources/uid/{uid}`），**不阻擋**，直接打 proxy；非 Prometheus 後端通常回 404 / 405 / 非 JSON。此時把「HTTP 404/405 + proxy 路徑」翻譯成 `DATASOURCE_TYPE_UNSUPPORTED` 而不是含糊的 `NOT_FOUND`，訊息提示先用 `grafana_list_datasources` 確認 uid 與 type。

`access === 'direct'` 一律拒絕（`DATASOURCE_NOT_PROXYABLE`），因為 direct 模式的 datasource 不經 Grafana 後端，proxy 必失敗。

「Prometheus 相容」的判定：`type === 'prometheus'`（大小寫不敏感）。Mimir / Thanos / VictoriaMetrics 在 Grafana 裡註冊的 `type` 通常仍是 `prometheus`，因此自動涵蓋。Loki 的 `type` 是 `loki`，v0.1 明確不支援（見 §10）。

### 2.4 unified alerting：兩個端點的差別與取捨

| 端點 | 回傳什麼 | 適合 |
| --- | --- | --- |
| `GET /api/v1/provisioning/alert-rules` | **規則定義**：`uid`、`title`、`folderUID`、`ruleGroup`、`condition`、`data[]`（完整查詢模型，含 `datasourceUid`、`model`、`relativeTimeRange`）、`for`、`noDataState`、`execErrState`、`labels`、`annotations`、`isPaused`。**不含當前狀態**。 | 「有哪些規則、閾值是什麼」 |
| `GET /api/prometheus/grafana/api/v1/rules` | **規則 + 當前狀態**：Prometheus 相容的 `data.groups[].rules[]`，每條含 `state`（`inactive`/`pending`/`firing`）、`health`、`lastEvaluation`、`evaluationTime`，以及 `alerts[]`（每個 instance 的 `labels`、`state`、`activeAt`、`value`）。 | 「現在誰在燒」 |

**已定：兩個工具、兩個端點，各取所長。**

- `grafana_list_alert_rules` → `/api/v1/provisioning/alert-rules`：agent 要看「規則怎麼定義的」。此端點回傳的 `data[]` 極為冗長（每條規則內嵌完整查詢 model），**必須大幅裁剪**（§3.6）。另注意它需要 provisioning 相關權限（`alert.provisioning:read`），權限不足會回 403 → `PERMISSION_DENIED`，訊息要點名需要的權限。
- `grafana_alert_state` → `/api/prometheus/grafana/api/v1/rules`：agent 要看「現在的狀態」。預設只回非 `inactive` 的規則。

**不採用** `/api/alertmanager/grafana/api/v2/alerts`（Alertmanager 實例層）：它只給已觸發的 instance、丟失規則層脈絡（rule title / folder），且 Grafana Cloud 的 Alertmanager 路由設定差異更大。

**狀態字串陷阱**：Grafana 早期版本在 `/api/prometheus/grafana/...` 系列曾回傳自家名稱（`Normal`/`Pending`/`Alerting`）而非 Prometheus 規範的 `inactive`/`pending`/`firing`（grafana/grafana#52453）。client 一律做大小寫不敏感的正規化，輸出統一為小寫 Prometheus 名稱，並在 `meta.stateVocabulary` 標記 `"prometheus"`（原樣即合規）或 `"grafana-normalized"`（有轉換發生）。無法辨識的狀態字串一律轉成 `unknown` 並保留原值於 `stateRaw`。

### 2.5 認證：service account token vs 舊 API key

**兩者 header 完全相同**：`Authorization: Bearer <token>`。

- **Service account token**（Grafana 9+，`glsa_` 前綴）：官方現行做法，權限綁在 service account 的 role/permission 上。**建議使用。**
- **舊 API key**（`eyJrIjoi…`，Grafana 11 起在 UI 移除建立入口、舊 key 仍可用）：同樣走 `Bearer`，**不需要額外程式碼即自動支援**。
- **Grafana Cloud Access Policy token**（`glc_`）：這類 token 是給 Cloud 的**資料端點**（`prometheus-prod-XX.grafana.net`、`logs-prod-XX`）用的，配 Basic auth（user = 數字 instance id）。**不是** Grafana HTTP API 的憑證，**v0.1 不支援**，也不需要支援——因為我們走的是 stack 本身的 `/api/...`。

**已定：只實作 `Authorization: Bearer <token>` 一種**，三種 Grafana 原生 token 自動涵蓋。不做 Basic auth、不做匿名、不做 `X-Grafana-Org-Id`。config 只有一個 `token` 欄位，不做 token 種類偵測（Simplicity first）。README 四語都要明列「service account token 與舊 API key 皆可，前者為建議做法；`glc_` 開頭的 Cloud Access Policy token 不適用」。

所需最小權限（README 四語都要寫）：

| 工具 | 需要的權限 |
| --- | --- |
| `grafana_health` | 無（`/api/health` 免認證，但仍會帶 token） |
| `grafana_list_datasources` | `datasources:read`（scope `datasources:*` 或收斂到特定 uid） |
| `grafana_query` / `grafana_query_range` | `datasources:read` + `datasources:query`（對應 uid scope） |
| `grafana_alert_state` | `alert.rules:read` |
| `grafana_list_alert_rules` | `alert.provisioning:read` |

### 2.6 Grafana Cloud 與自架的差異

| 面向 | 自架 | Grafana Cloud |
| --- | --- | --- |
| baseUrl | 自訂網域，可能帶 sub-path（`https://ops.example.com/grafana/`） | `https://<stack>.grafana.net/` |
| datasource proxy | 可用 | **可用**，且是拿 Cloud metrics 最省事的路（免另外配 `glc_` token 與 prod 端點） |
| `/api/datasources` | 通常拿得到全部 | 同樣可用，但 Cloud stack 內建大量 datasource（含 `grafanacloud-*-usage`、`-alerts`、`-smetrics`），清單很長 |
| token | service account token / 舊 API key | service account token（`glsa_`）；Access Policy token（`glc_`）不適用於此 API |
| org | 多 org 可能存在 | 單一 stack 單 org，`X-Grafana-Org-Id` 幾無意義 |
| rate limit | 幾乎無 | 有；proxy 查詢過大時可能回 429 → `RATE_LIMITED`，`Retry-After` 帶進 error |
| 回應大小 | 受自架 Prometheus 限制 | Cloud 對 query 有 series/samples 上限，超限回 422 或 400 帶 `status:"error"` |

對設計的影響：

1. `baseUrl` **必須支援 sub-path**（自架常見）。正規化時保留 pathname 並補尾斜線，所有 endpoint 以相對路徑 join（沿用 `dsh-sonarqube` 的 `normalizeBaseUrl` + `new URL(endpoint, baseUrl)`）。
2. `grafana_list_datasources` 必須支援 `type` 與 `name_contains` 篩選 + 分頁，否則 Cloud stack 的清單會直接吃掉 agent context。
3. Prometheus 層錯誤（body 為 `{"status":"error","errorType":...,"error":...}`）要翻成 `UPSTREAM_QUERY_FAILED`；其中 **HTTP 400 時**把過濾截斷後的 `error` 訊息帶給 agent——這是 PromQL 打錯字時唯一有用的線索（政策見 §6.2）。
4. README 四語都需有「Grafana Cloud 設定」小節（baseUrl 用 `https://<stack>.grafana.net/`、token 用 service account token、不要用 `glc_`）。

---

## 3. v0.1 工具清單

共 6 個工具，全部唯讀、全部 `isConcurrencySafe: () => true`、輸出統一 `OUTPUT_SCHEMA`（`{ data, meta }`）並 render 成單一 JSON text。

**tool name 一律固定英文（snake_case），不隨 locale 變動**；**tool description 與每個參數的 description 依 `config.locale` 從 `src/locales.ts` 取四語其一**（見 §5 與 §7）。下表列的是英文版語意，四語必須語意等價、且都要提到同樣的上限數字。

### 3.1 `grafana_health`

- **用途**：確認 baseUrl 與 token 設定正確、Grafana 可達。診斷第一站。
- **Endpoint**：`GET {base}api/health`
- **參數**：無
- **回應裁剪策略**：回應本身極小（`{database, version, commit}`）。白名單保留 `database`、`version`；`commit` 丟棄（對 agent 無用）。`meta` 為 `{}`。
- **錯誤情境**：非 JSON（baseUrl 指到反向代理登入頁）→ `INVALID_RESPONSE`；連不上 → `NETWORK_ERROR`；逾時 → `REQUEST_TIMEOUT`。

### 3.2 `grafana_list_datasources`

- **用途**：列出 datasource，取得後續查詢所需的 `uid`。這是所有查詢的前置步驟。
- **Endpoint**：`GET {base}api/datasources`
- **參數**：

| 參數 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `type` | string | 否 | 依 datasource 類型篩選，例如 `prometheus`。大小寫不敏感、精確比對。 |
| `name_contains` | string | 否 | 名稱子字串篩選（大小寫不敏感），1–200 字元。 |
| `page` | integer | 否 | 1-based，預設 1。 |
| `page_size` | integer | 否 | 預設 20，上限 100。 |

- **回應裁剪策略**：Grafana 回傳的每個 datasource 含 `password`、`basicAuthPassword`、`secureJsonFields`、`jsonData`、`typeLogoUrl` 等大量無用或敏感欄位。**採白名單**，每筆只保留：
  `uid`、`name`、`type`、`isDefault`、`access`、`readOnly`、`url`（僅在 `access !== 'direct'` 時保留，且**去除 URL 內嵌帳密**後輸出；URL 無法解析時整個省略）。
  分頁在 client 端做（Grafana 此端點不支援分頁，預設最多回 5000 筆）：先套 filter、再切頁。
  `meta` 為 `{ total, page, pageSize, truncated }`（`total` 是套用 filter 後、切頁前的數量）。
- **副作用**：結果同時餵進 client 的 datasource cache（uid → `{type, access}`），供後續查詢做前置檢查。
- **錯誤情境**：401 → `AUTHENTICATION_FAILED`；403（缺 `datasources:read`）→ `PERMISSION_DENIED`；非 JSON → `INVALID_RESPONSE`；超過 `maxResponseBytes` → `RESPONSE_TOO_LARGE`。

### 3.3 `grafana_query`（instant query）

- **用途**：對單一時間點執行 PromQL，回答「現在的值是多少」。
- **Endpoint**：`GET {base}api/datasources/proxy/uid/{uid}/api/v1/query`
- **參數**：

| 參數 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `datasource_uid` | string | **是** | 來自 `grafana_list_datasources`。1–100 字元，`[A-Za-z0-9_-]+`。 |
| `query` | string | **是** | PromQL 運算式，1–4000 字元。 |
| `time` | string | 否 | RFC3339 或 Unix 秒（可帶小數）。省略 = 現在。 |
| `timeout` | string | 否 | Prometheus 端查詢逾時，Prometheus duration 格式（如 `10s`）；必須 ≤ `requestTimeoutMs`，否則 `INVALID_INPUT`。 |

- **回應裁剪策略**：
  - 只保留 `data.resultType` 與 `data.result`。`warnings` 移到 `meta.warnings`（最多 5 條、每條 200 字元），其餘欄位丟棄。
  - **series 上限 `maxSeries`（config 欄位，預設 100）**：超過則截斷至前 `maxSeries` 筆，`meta.truncated = true`、`meta.seriesTotal` 給實際數量，並在 `meta.hint` 附「加上 label filter 或用聚合函式（`topk` / `sum by`）縮小結果」。
  - 每個 series 的 label set 若超過 30 個 label，或單一 label value 超過 200 字元，截斷並在該 series 加 `labelsTruncated: true`（防禦性；正常不會觸發）。
  - instant query 每個 series 只有一個樣本，因此不需要點數控制。
  - `meta` 為 `{ seriesReturned, seriesTotal, truncated, warnings?, hint? }`。
- **錯誤情境**：
  - datasource type 非 `prometheus` → `DATASOURCE_TYPE_UNSUPPORTED`（前置檢查，不發請求）
  - `access === 'direct'` → `DATASOURCE_NOT_PROXYABLE`
  - uid 不存在 → Grafana 回 404 → `NOT_FOUND`（訊息提示先跑 `grafana_list_datasources`）
  - PromQL 語法錯 → Prometheus 回 400 + `{"status":"error","errorType":"bad_data","error":"..."}` → `UPSTREAM_QUERY_FAILED`，**帶 `errorType` 與過濾截斷後的 `error`**（§6.2）
  - Prometheus 回 422（超過 series/samples 上限）或 HTTP 200 但 body `status: "error"` → `UPSTREAM_QUERY_FAILED`，**只帶 `errorType`，不帶 `error` 自由文字**（§6.2）
  - 429 → `RATE_LIMITED`（帶 `Retry-After`）
  - 逾時 / 中止 / 網路 → `REQUEST_TIMEOUT` / `REQUEST_ABORTED` / `NETWORK_ERROR`

### 3.4 `grafana_query_range`（區間 query）

- **用途**：查一段時間的走勢。**這是最容易炸掉 agent context 的工具，因此點數控制是硬性的。**
- **Endpoint**：`GET {base}api/datasources/proxy/uid/{uid}/api/v1/query_range`
- **參數**：

| 參數 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `datasource_uid` | string | **是** | 同 §3.3。 |
| `query` | string | **是** | PromQL，1–4000 字元。 |
| `start` | string | **是** | RFC3339 或 Unix 秒。 |
| `end` | string | **是** | 同上；必須 > `start`。 |
| `step` | string | 否 | Prometheus duration（`15s` / `1m` / `5m`）或純秒數。**省略時由插件自動計算**（見下）。 |
| `max_points` | integer | 否 | 每個 series 的點數上限，1–500，預設 200。 |

- **step 與點數上限（核心規則）**：

  1. 令 `rangeSeconds = end - start`；`requiredStep = ceil(rangeSeconds / max_points)`。
  2. **`step` 省略** → 自動採用刻度集合 `[1s, 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 6h, 12h, 1d]` 中第一個 ≥ `requiredStep` 的值（若 `requiredStep` 大於 `1d`，則直接用 `requiredStep` 秒）。這就是**降採樣**：agent 拿到的點數必然 ≤ `max_points`。`meta.stepApplied` 回報實際使用值（秒）、`meta.stepAuto = true`。
  3. **`step` 明確指定且 `ceil(rangeSeconds / step) > max_points`** → **直接拒絕**，丟 `QUERY_RANGE_TOO_LARGE`，訊息帶三個具體數字：預估點數、`max_points` 上限、以及「把 step 調到至少 `requiredStep` 秒，或把區間縮到 `max_points × step` 秒以內」。**不猜使用者意圖、不偷偷改參數。**
  4. 硬上限：`step` 必須 ≥ 1 秒；`rangeSeconds` 必須 ≥ 1 秒且 ≤ 31 天（`MAX_RANGE_SECONDS`）。
  5. **總點數上限**：回應後檢查 `Σ(每 series 點數)`，超過 `MAX_TOTAL_POINTS`（20000）時**截斷 series**（保留前 N 個完整 series，而非砍每個 series 的尾巴——半截的時序對 agent 沒有意義），並標記 `meta.truncated`。

- **回應裁剪策略**：
  - 保留 `resultType: "matrix"` 與 `result[].{metric, values}`。
  - series 數超過 `maxSeries`（config，預設 100）→ 先截斷；再套 `MAX_TOTAL_POINTS`（可能再截更少）。
  - 逐 series 檢查點數；理論上受 `step` 保證，但若後端回傳超量（step 被後端調整），截掉尾端多出的點並在該 series 加 `pointsTruncated: true`。
  - `meta` 完整欄位：`{ stepApplied, stepAuto, maxPoints, seriesReturned, seriesTotal, totalPoints, truncated, warnings?, hint? }`。
- **錯誤情境**：§3.3 全部 + `QUERY_RANGE_TOO_LARGE` + `INVALID_INPUT`（`end <= start`、時間格式不合法、step 格式不合法、區間超過 31 天、`max_points` 超界）。

### 3.5 `grafana_alert_state`

- **用途**：現在有哪些告警在燒。
- **Endpoint**：`GET {base}api/prometheus/grafana/api/v1/rules`
- **參數**：

| 參數 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `state` | string[] | 否 | `firing` / `pending` / `inactive` 的子集（1–3 個值）。**預設 `["firing","pending"]`**——agent 問「現在怎樣」時不該被幾百條 inactive 淹沒。 |
| `folder_contains` | string | 否 | folder（Prometheus 語意的 group `file`）子字串篩選，大小寫不敏感。 |
| `rule_contains` | string | 否 | 規則名稱子字串篩選，大小寫不敏感。 |
| `include_instances` | boolean | 否 | 預設 `true`。是否附上每條規則的 alert instance。 |
| `max_instances_per_rule` | integer | 否 | 預設 10，上限 50。 |
| `page` / `page_size` | integer | 否 | 對「攤平後的規則清單」分頁；`page_size` 預設 20、上限 100。 |

- **回應裁剪策略**：
  - 把巢狀的 `data.groups[].rules[]` **攤平成單層規則陣列**，每條為 `{ group, folder, name, state, stateRaw?, health, labels, annotations, lastEvaluation, evaluationTime, duration, activeInstances? }`。巢狀結構對 agent 沒有價值，攤平後好篩好讀。
  - `annotations` 只留 `summary` / `description` / `runbook_url`，各截斷至 500 字元。
  - `state` 依 §2.4 正規化為小寫 Prometheus 詞彙；`meta.stateVocabulary` 標記來源詞彙。
  - `activeInstances[]` 每條只留 `{ labels, state, activeAt, value }`，`value` 截斷至 200 字元（Grafana 會塞整包 `[ var='B0' metric='...' labels={...} value=... ]` 字串）。每條規則最多 `max_instances_per_rule` 個，超過時該規則加 `instancesTruncated: true` 與 `instancesTotal`。
  - 規則層上限 `MAX_ALERT_RULES`（500），超過則截斷 + `meta.truncated`。
  - `meta` 為 `{ total, page, pageSize, truncated, stateVocabulary, counts: { firing, pending, inactive, unknown } }`——`counts` 是**套用篩選前**的總計，讓 agent 一眼知道全貌。
- **錯誤情境**：403（缺 `alert.rules:read`）→ `PERMISSION_DENIED`；404 → `ALERTING_UNAVAILABLE`；其餘同通用集合。

### 3.6 `grafana_list_alert_rules`

- **用途**：列出 Grafana unified alerting 的**規則定義**（不是狀態）。
- **Endpoint**：`GET {base}api/v1/provisioning/alert-rules`
- **參數**：

| 參數 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `folder_uid` | string | 否 | 只回該 folder 的規則。 |
| `rule_group` | string | 否 | 只回該 group 的規則。 |
| `title_contains` | string | 否 | 標題子字串篩選，大小寫不敏感。 |
| `include_query` | boolean | 否 | 預設 `false`。`true` 時額外附上每條規則的查詢摘要。 |
| `page` / `page_size` | integer | 否 | 1-based；`page_size` 預設 20、上限 100。 |

- **回應裁剪策略（本插件裁剪力度最大的一處）**：此端點會回傳所有規則、每條內嵌完整 `data[]` 查詢模型（`model` 是整包 datasource plugin 的 query JSON），一個中型 stack 輕易數 MB。**採白名單 + 摘要**：
  - 預設每條只保留：`uid`、`title`、`folderUID`、`ruleGroup`、`condition`、`for`、`isPaused`、`noDataState`、`execErrState`、`labels`、`annotations`（同 §3.5，只留三個鍵、各截 500 字元）。
  - **`data[]` 預設整包丟棄**。`include_query: true` 時，改成每個 refId 一個摘要物件 `{ refId, datasourceUid, expr?, type? }`——`expr` 從 `model.expr` 取（取不到就省略）；`type` 標記 Grafana 表達式節點（`datasourceUid === '__expr__'` 時取 `model.type`，如 `reduce` / `threshold`）。`expr` 截斷至 1000 字元。
  - 篩選與分頁全在 client 端做（此端點不支援 query 參數篩選）。`meta` 為 `{ total, page, pageSize, truncated }`。
  - 硬防線：即使全部裁剪過，仍受 `maxResponseBytes` 保護（讀取階段就會中止，見 §4）。
- **錯誤情境**：403（缺 `alert.provisioning:read`）→ `PERMISSION_DENIED`，訊息明講需要的權限名；404（Grafana < 9 或 unified alerting 未啟用）→ `ALERTING_UNAVAILABLE`；其餘同通用集合。

---

## 4. 回應大小控制總表

三道防線，由外而內：

| 層 | 機制 | 觸發後行為 |
| --- | --- | --- |
| 傳輸層 | `maxResponseBytes`（預設 5 MB）+ `Content-Length` 預檢 + streaming 逐塊累計 | 立即 `reader.cancel()` 並丟 `RESPONSE_TOO_LARGE`（沿用 `dsh-sonarqube` 的 `readBoundedBody`） |
| 請求層 | `query_range` 的 step / 點數預估 | 自動降採樣（step 省略時）或 `QUERY_RANGE_TOO_LARGE` 拒絕（step 明確指定時） |
| 裁剪層 | 白名單欄位 + `maxSeries` / `max_points` / `MAX_TOTAL_POINTS` / `MAX_ALERT_RULES` / 字串截斷 | 截斷並在 `meta` 標記 `truncated` 與總量，附 `hint` 教 agent 怎麼縮小 |

原則：**任何截斷都必須在 `meta`（或該筆記錄上）留痕**。agent 不能在不知情的狀況下拿到不完整的資料而據以下結論。

常數（`src/client.ts` 頂部；`maxSeries` 例外，是 config 欄位）：

```
DEFAULT_MAX_SERIES        = 100      // config.maxSeries 的預設值
MAX_SERIES_LIMIT          = 1_000    // config.maxSeries 的上界
MAX_POINTS_PER_SERIES     = 500      // max_points 參數的硬上限
DEFAULT_MAX_POINTS        = 200
MAX_TOTAL_POINTS          = 20_000
MAX_RANGE_SECONDS         = 31 * 86_400
MAX_ALERT_RULES           = 500
MAX_INSTANCES_PER_RULE    = 50
DEFAULT_INSTANCES_PER_RULE= 10
MAX_QUERY_LENGTH          = 4_000
MAX_PAGE_SIZE             = 100
DEFAULT_PAGE_SIZE         = 20
MAX_UPSTREAM_ERROR_CHARS  = 200      // §6.2
DATASOURCE_CACHE_TTL_MS   = 60_000
DATASOURCE_CACHE_MAX      = 200
```

---

## 5. Config schema

環境變數前綴 `GRAFANA_`。**plugin config 覆蓋環境變數**（`config.x?.trim() || env.GRAFANA_X?.trim() || ''`）。

| 欄位 | 型別 | 環境變數 | 預設 | 下界 | 上界 | 說明 |
| --- | --- | --- | --- | --- | --- | --- |
| `baseUrl` | string | `GRAFANA_URL` | —（必填） | — | — | Grafana 根位址，可含 sub-path。必須 http(s)、無內嵌帳密、無 query/fragment；正規化後補尾斜線。 |
| `token` | string | `GRAFANA_TOKEN` | —（必填） | 1 字元 | — | Service account token（建議）或舊 API key。Schemastery `.role('secret')`。 |
| `locale` | enum | — | `en` | — | — | **tool description 與參數說明的語言**：`en` / `zh-TW` / `zh-CN` / `ja`。非四者之一 → `INVALID_CONFIG`。 |
| `requestTimeoutMs` | number | — | 30000 | 1 | 300000（5 分鐘） | 單次請求逾時。 |
| `maxResponseBytes` | number | — | 5242880（5 MB） | 1 | 52428800（50 MB） | 成功回應 body 上限。 |
| `maxSeries` | number | — | 100 | 1 | 1000 | 單次查詢回傳的 series 數上限。 |

`baseUrl` 驗證規則（沿用 `dsh-sonarqube` 的 `normalizeBaseUrl`，逐條照抄）：

1. `new URL(value)` 必須成功，否則 `INVALID_CONFIG`。
2. protocol 必須是 `http:` 或 `https:`。
3. `url.username` / `url.password` 必須為空（禁止 `https://user:pass@host`）。
4. `url.search` / `url.hash` 必須為空。
5. `pathname` 去除尾端多餘斜線後補一個 `/`（保住 sub-path）。

數值欄位驗證：`Number.isSafeInteger(v) && v >= 1 && v <= MAX`，否則 `INVALID_CONFIG` 並在訊息裡帶欄位名與範圍。

`locale` 的資料流：`index.ts` 的 `apply(ctx, config)` 取出 `resolved.locale` → `registerGrafanaTools(ctx, client, locale)` → `tools.ts` 內 `const messages = grafanaMessages(locale)` → 每個 `defineTool()` 的 `description`、參數 `description`、`presentCall().title` 全部取自 `messages`。**client 與 errors 不吃 locale**（錯誤訊息一律英文，見 §6）。

`cordis.patch.yml`（registry 硬性要求，`package.json` 必須有 `dsh.bundle.patch` 指向它）：

```yaml
- insert:
    - id: dsh-grafana
      name: dsh-grafana
      config:
        baseUrl: ''
        token: ''
        locale: en
        requestTimeoutMs: 30000
        maxResponseBytes: 5242880
        maxSeries: 100
```

`CONFIG_I18N`（Schemastery 用）必須涵蓋上列 6 個欄位 + `$description`，語系鍵 7 個：`en` / `en-US` / `zh` / `zh-CN` / `zh-TW` / `ja` / `ja-JP`。

---

## 6. 錯誤處理

### 6.1 錯誤碼清單

型別 `GrafanaErrorCode`。前 13 個沿用 `dsh-sonarqube/src/errors.ts` 的形狀（把 `SONARQUBE_HTTP_ERROR` 換成 `GRAFANA_HTTP_ERROR`），後 5 個是 Grafana 專屬。**錯誤訊息一律英文，不隨 `locale` 變動**——這些字串是給模型讀的診斷資訊，英文最準確也最省 token。

| 代碼 | 觸發條件 | 對應 HTTP | 訊息要點 |
| --- | --- | --- | --- |
| `INVALID_CONFIG` | baseUrl / token / locale 不合法、數值超界 | — | 指名欄位與合法範圍 |
| `INVALID_INPUT` | 工具參數不合法（uid 格式、query 過長、`end <= start`、step / duration 格式、分頁超界、`state` 值不在允許集合） | — | 指名參數與合法範圍 |
| `AUTHENTICATION_FAILED` | token 錯誤或過期 | 401 | 「檢查 GRAFANA_TOKEN」 |
| `PERMISSION_DENIED` | service account 權限不足 | 403 | **點名所需權限**（`datasources:read` / `datasources:query` / `alert.rules:read` / `alert.provisioning:read`） |
| `NOT_FOUND` | datasource uid 不存在、endpoint 不存在 | 404 | 提示先跑 `grafana_list_datasources` |
| `RATE_LIMITED` | Grafana Cloud 或反向代理限流 | 429 | 帶 `Retry-After`（經 `safeHeader` 過濾） |
| `SERVER_ERROR` | Grafana 端錯誤 | ≥500 | 只帶 status，不帶 body |
| `GRAFANA_HTTP_ERROR` | 其他未歸類的非 2xx | 其他 | 只帶 status |
| `NETWORK_ERROR` | DNS / 連線失敗 | — | 「無法連線到 Grafana」 |
| `REQUEST_TIMEOUT` | 超過 `requestTimeoutMs` | — | 帶實際 ms |
| `REQUEST_ABORTED` | 呼叫端 `exec.signal` 取消 | — | — |
| `INVALID_RESPONSE` | 非 JSON content-type、JSON 解析失敗、頂層非物件 | — | 提示 baseUrl 可能指到登入頁 / 反向代理 |
| `RESPONSE_TOO_LARGE` | 超過 `maxResponseBytes` | — | 帶上限值 |
| `DATASOURCE_TYPE_UNSUPPORTED` | 目標 datasource 的 `type` 不是 `prometheus`；或 proxy 路徑回 404/405 | —／404／405 | 帶實際 type（若已知），說明 v0.1 只支援 Prometheus |
| `DATASOURCE_NOT_PROXYABLE` | datasource `access === 'direct'` | — | 說明需改為 server (proxy) 模式 |
| `QUERY_RANGE_TOO_LARGE` | 明確 step 下預估點數超過 `max_points` | — | 帶 預估點數／上限／建議 step |
| `UPSTREAM_QUERY_FAILED` | Prometheus 回 `{"status":"error"}`（400 / 422 / HTTP 200 皆可能） | 400/422/200 | 一律帶 `errorType`；**僅 HTTP 400 額外帶過濾截斷後的 `error`**（§6.2） |
| `ALERTING_UNAVAILABLE` | unified alerting 端點 404 | 404 | 說明最低版本需求（Grafana 9.0） |

錯誤物件不變式（照 `dsh-sonarqube`）：

- `GrafanaApiError extends Error`，欄位 `code` / `status?` / `retryAfter?` / `errorType?` / `upstreamMessage?`，`toJSON()` 只吐這些。
- **永不**把 token、`Authorization` header 放進任何欄位。header 透過 `safeHeader()` 過濾（長度 ≤128 且不含 token 才採用）。

### 6.2 上游錯誤訊息透出政策（**刻意偏離 dsh-sonarqube 的例外**）

> **與 `dsh-sonarqube` 不同，此處為刻意例外，理由是 query 語法錯誤若不回饋，agent 只能盲猜。**

規則（硬性，全部要有對應測試）：

1. **只在上游 HTTP 狀態為 400 時**才把上游錯誤說明透出。401 / 403 / 404 / 405 / 422 / 429 / 5xx 一律維持靜態訊息，**永不夾帶 body**。
2. **只取結構化欄位**：Prometheus 錯誤 body 的 `error` 欄位（字串）。若 body 不是 JSON、或 `error` 不是字串，則不透出任何東西。**絕不整包丟 response body。**
3. **長度上限 200 字元**（`MAX_UPSTREAM_ERROR_CHARS`），超過截斷並補 `…`。
4. **過濾疑似機密**：透出前先跑 redaction——
   - 若字串包含設定中的 `token` 子字串 → 整個丟棄，不透出。
   - 以下 pattern 命中就把命中片段換成 `[redacted]`：`glsa_\S+`、`glc_\S+`、`eyJ[A-Za-z0-9._-]{10,}`（JWT 樣式）、`(?i)(authorization|bearer|api[-_]?key|password|secret|token)\s*[:=]\s*\S+`。
   - redaction 後若剩餘可見字元少於 8 個 → 整個丟棄。
5. 透出的內容放在 `GrafanaApiError.upstreamMessage`，並**附加**到 `message` 尾端（格式：`Prometheus rejected the query (bad_data): <upstreamMessage>`）。
6. `errorType` 本身是 Prometheus 的固定詞彙（`bad_data` / `timeout` / `canceled` / `execution` / `internal` / `unavailable` / `not_acceptable`），非自由文字，因此**任何狀態碼都可帶**；非白名單值一律丟棄。

---

## 7. 檔案結構與各檔職責

```
dsh-grafana/
├── src/
│   ├── config.ts       ~120 行
│   ├── errors.ts       ~175 行   (含 §6.2 redaction)
│   ├── types.ts        ~ 90 行
│   ├── client.ts       ~450 行
│   ├── tools.ts        ~260 行
│   ├── locales.ts      ~340 行   (config i18n + 6 工具 tool metadata，四語)
│   └── index.ts        ~ 90 行
├── tests/
│   ├── config.test.ts     ~130 行
│   ├── client.test.ts     ~420 行
│   ├── errors.test.ts     ~120 行
│   ├── tools.test.ts      ~200 行
│   └── locales.test.ts    ~ 60 行
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
├── cordis.patch.yml
├── package.json
├── tsconfig.json / tsconfig.build.json
├── vitest.config.ts
├── biome.json
├── README.md / README.zh-TW.md / README.zh-CN.md / README.ja.md
└── LICENSE (MIT)
```

`src/` 合計約 **1525 行**，高於 `dsh-sonarqube` 的 950 行——多出來的主要是 query_range 的 step/點數邏輯、四語 tool metadata（`locales.ts` 一檔就 ~340 行）、以及 §6.2 的 redaction。

| 檔案 | 職責 | 不做什麼 |
| --- | --- | --- |
| `config.ts` | 常數（timeout / bytes / maxSeries 上下界）、`GrafanaConfig` / `ResolvedGrafanaConfig` 介面、`LOCALES` 常數與 `Locale` 型別、`resolveConfig()`（config 覆蓋 env）、`validateResolvedConfig()`、`normalizeBaseUrl()` | 不碰 HTTP、不知道有哪些工具 |
| `errors.ts` | `GrafanaErrorCode` 聯合型別、`GrafanaApiError` 類別、`createHttpError(status, …)` 的 status→code 映射、`createUpstreamError(status, body, token)`（含 §6.2 的 400-only 判斷、`errorType` 白名單、截斷、redaction）、`safeHeader()` | 不做 i18n（錯誤訊息一律英文） |
| `types.ts` | `JsonValue` / `JsonObject` 別名、`ApiResult<T> = { data, meta }`、各工具的參數介面（`ListDatasourcesParams` / `QueryParams` / `QueryRangeParams` / `AlertStateParams` / `ListAlertRulesParams`） | 純型別，vitest coverage 排除 |
| `client.ts` | `GrafanaClient` 類別：`health` / `listDatasources` / `query` / `queryRange` / `alertState` / `listAlertRules`；共用 `#get()`（AbortController + timeout + streaming bounded body + content-type 檢查 + 錯誤正規化）；datasource cache；step 計算與點數預估；所有裁剪與正規化 helper | 不引用 cordis / dsh-tools（可獨立單測）；不吃 locale |
| `tools.ts` | `registerGrafanaTools(ctx, client, locale)`：取 `grafanaMessages(locale)` 後註冊 6 個 `defineTool()`；`OUTPUT_SCHEMA` 常數；參數 schema（description 取自 messages）；`presentCall`；`renderJson` | 不含業務邏輯——只做 snake_case 參數 → client camelCase 的轉接 |
| `locales.ts` | `LOCALES` 對應的 `GrafanaMessages` 介面 + 四個實作（`ENGLISH` / `TRADITIONAL_CHINESE` / `SIMPLIFIED_CHINESE` / `JAPANESE`）+ `grafanaMessages(locale)` 取值函式；另有 `CONFIG_I18N`（Schemastery 用，7 語系鍵） | 不含錯誤訊息 |
| `index.ts` | Cordis 插件入口：`name` / `inject = ['tools']` / Schemastery `Config`（含 `locale` enum）/ `apply(ctx, config)`（建 client → 取 locale → `registerGrafanaTools`）；re-export 公開型別與 client | 不含邏輯 |

`GrafanaMessages` 介面必須包含（四語鍵集合完全一致）：6 個 `*Description`、6 個 `*Title`（`presentCall` 用）、以及所有工具參數的 description（`datasourceUid` / `query` / `time` / `timeout` / `start` / `end` / `step` / `maxPoints` / `type` / `nameContains` / `state` / `folderContains` / `ruleContains` / `includeInstances` / `maxInstancesPerRule` / `folderUid` / `ruleGroup` / `titleContains` / `includeQuery` / `page` / `pageSize`）。

`OUTPUT_SCHEMA`（照 `dsh-sonarqube` 形狀，`meta` 放寬為 `json`，因為各工具的 `meta` 形狀不同）：

```ts
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: { type: 'json', required: true },
    meta: { type: 'json', required: true },
  },
} as const
```

---

## 8. 專案慣例檢查清單（必須全數滿足）

1. **`package.json` 必須有 `dsh.bundle.patch` → `./cordis.patch.yml`**。registry 硬性要求；只宣告 `dsh.client` 會被退件。
2. **peerDependencies 的 `@deepseek-ai/*` 範圍必須寫顯式 prerelease 分支**：
   ```json
   "peerDependencies": {
     "@deepseek-ai/cordis": "^4.0.1",
     "@deepseek-ai/dsh-tools": "^0.1.0-rc.8 || ^0.1.1-rc.2",
     "@deepseek-ai/schemastery": "^3.18.1"
   }
   ```
   只寫 `^0.1.0-rc.8` 會被 node-semver 靜默排除 `0.1.1-rc.2`，使用者安裝直接 ERESOLVE（`dsh-sonarqube` 實際踩過）。
3. **release workflow**（`v*` tag 觸發）：
   - checkout → setup-bun → `bun install --frozen-lockfile`
   - `bun run lint` → `bun run typecheck` → `bun run test --coverage` → `bun run build`
   - **驗 tag 與 package.json 版本一致**：`test "$GITHUB_REF_NAME" = "v${PACKAGE_VERSION}"`
   - `bun pm pack` → `tar --list` 驗完整性 → `cp` 出穩定檔名 `dsh-grafana.tgz` → `sha256sum` 產 `SHA256SUMS`
   - **tarball 檔名必須透過 `$GITHUB_ENV` 傳給下一個 step**：`echo "PACKAGE_TARBALL=$PACKAGE_TARBALL" >>"$GITHUB_ENV"`（跨 step shell 變數不保留，`dsh-forge` v0.3.2 因此掛過）
   - `gh release create "$GITHUB_REF_NAME" "$PACKAGE_TARBALL" dsh-grafana.tgz SHA256SUMS --verify-tag --generate-notes`
   - 穩定檔名 asset `dsh-grafana.tgz` 讓 `releases/latest/download/dsh-grafana.tgz` 跨版本不壞
4. **四語 README**：`README.md`（en）/ `README.zh-TW.md` / `README.zh-CN.md` / `README.ja.md`，頂部互相連結；四份都必須有 Tools 表（6 個）、Configuration 表（6 個欄位，含 `locale`）、Grafana Cloud 小節、最小權限表、Security and error behavior（含 §6.2 的 400-only 政策）。**runtime tool metadata 也四語**（`src/locales.ts` + `config.locale`）。
5. **MIT license**；GitHub repo 打 `dsh-plugin` + `grafana` topic（另加 `prometheus`、`promql`、`observability`）。
6. **npm unscoped 名稱 `dsh-grafana`**，`publishConfig.access = "public"`。npm 帳號 `maxhsu`、GitHub 帳號 `maxmilian`（兩者不同，`repository.url` 用 `maxmilian`）。
7. **所有工具 `isConcurrencySafe: () => true`**，輸出走統一 `OUTPUT_SCHEMA`（`data` + `meta`），render 成單一 JSON text。
8. **config 解析**：plugin config 覆蓋環境變數；URL 驗 http(s)、無內嵌帳密、無 query/fragment；`requestTimeoutMs`、`maxResponseBytes`、`maxSeries` 有上下界。
9. `files` 白名單含 `lib`、`cordis.patch.yml`、四份 README、`LICENSE`。
10. `engines.node`: `^22.19.0 || >=24.0.0`；`packageManager`: `bun@1.3.5`；lint/format 用 Biome。

---

## 9. 測試策略

框架 vitest，`environment: 'node'`，coverage v8，門檻 80%（branches/functions/lines/statements），`src/types.ts` 排除。**不打真實 Grafana**——全部 mock `fetch`（live 驗證另見 §11）。

`GrafanaClient` 的 constructor 第二參數接受 `fetchImplementation`（照 `dsh-sonarqube`），測試注入一個記錄 `(url, init)` 並回傳預先組好的 `Response` 的 stub。搭配一個 `jsonResponse(body, { status, headers })` helper；`RESPONSE_TOO_LARGE` 的測試需要自訂 `ReadableStream`，因此不導入 MSW。

### `tests/config.test.ts`

- config 覆蓋 env、env fallback、兩者皆缺 → `INVALID_CONFIG`
- baseUrl：`ftp://`、`https://u:p@h`、帶 `?a=1`、帶 `#x` 全部拒絕
- baseUrl sub-path 正規化：`https://h/grafana` → `https://h/grafana/`；`https://h/grafana///` → `https://h/grafana/`
- `locale`：四個合法值各通過；`de`、空字串、非字串 → `INVALID_CONFIG`；省略 → 預設 `en`
- `requestTimeoutMs` / `maxResponseBytes` / `maxSeries` 的 0、負數、小數、超上限

### `tests/errors.test.ts`（§6.2 專屬）

- **400 才透出**：同一份 body（`{"status":"error","errorType":"bad_data","error":"parse error at char 5"}`）分別以 400 / 422 / 200 建構 → 只有 400 的 `upstreamMessage` 有值，其餘為 `undefined`
- **只取結構化欄位**：body 是純文字 HTML、body 是 JSON 但 `error` 為物件 / 數字 → 不透出
- **200 字元截斷**：300 字元的 `error` → `upstreamMessage.length === 200`（含 `…`）
- **redaction**：`error` 含設定中的 token → 整個丟棄；含 `glsa_xxx` / `glc_xxx` / JWT 樣式 / `Authorization: Bearer xxx` → 對應片段變 `[redacted]`；redaction 後剩餘可見字元 < 8 → 丟棄
- **`errorType` 白名單**：`bad_data` 保留；`weird_type` 丟棄；任何狀態碼都能帶 `errorType`
- **`toJSON()`** 只含 `name` / `code` / `status` / `retryAfter` / `errorType` / `upstreamMessage`，且斷言序列化字串**不含** token
- HTTP status → code 映射：401/403/404/405/429/500/418 逐一

### `tests/client.test.ts`（主戰場）

- **URL 組裝**：sub-path baseUrl + uid proxy 路徑 → 斷言最終 URL 完全等於預期字串（query 參數逐一比對，不依賴順序）
- **Authorization header** 為 `Bearer <token>`；斷言 token **不出現在**任何拋出的 error 的 `message` / `toJSON()` 中
- **`grafana_health` 裁剪**：mock 回 `{database, version, commit}` → 輸出只有 `database`、`version`
- **step 計算表格測試**（`it.each`）：`(rangeSeconds, max_points, 預期 stepApplied)` 覆蓋每個刻度邊界，含 `requiredStep > 1d` 的落地
- **`QUERY_RANGE_TOO_LARGE`**：明確 step 過小 → 拋錯且**斷言 fetch 從未被呼叫**
- **series 截斷**：mock 回 150 series、`maxSeries = 100` → `data.result.length === 100`、`meta.truncated === true`、`meta.seriesTotal === 150`
- **`maxSeries` config 生效**：同一份 mock 在 `maxSeries = 5` 下回 5 筆
- **`MAX_TOTAL_POINTS`**：series × points 超量 → 截 series 而非截點；斷言剩下的每個 series 點數完整
- **datasource type 檢查**：cache 命中 `type: 'mysql'` → `DATASOURCE_TYPE_UNSUPPORTED` 且 fetch 未被呼叫；`access: 'direct'` → `DATASOURCE_NOT_PROXYABLE`；metadata 取不到（403）→ 不阻擋、直接打 proxy
- **proxy 404/405 → `DATASOURCE_TYPE_UNSUPPORTED`**（而非 `NOT_FOUND`）
- **datasource 欄位白名單**：mock 回含 `password` / `basicAuthPassword` / `secureJsonFields` / `jsonData` → 斷言輸出 JSON 字串**不含**這些字樣；`url` 內嵌帳密 → 輸出已去除帳密
- **`UPSTREAM_QUERY_FAILED`**：(a) HTTP 400 帶 `error` → 透出；(b) HTTP 200 但 body `status: "error"`（Prometheus 的怪癖）→ 只帶 `errorType`；(c) HTTP 422 → 只帶 `errorType`
- **alert state 正規化**：mock 回 `Alerting`/`Normal` → 輸出 `firing`/`inactive`，`meta.stateVocabulary === 'grafana-normalized'`；未知字串 → `unknown` + `stateRaw`
- **alert state 攤平與 `counts`**：兩個 group 共 5 條規則 → 輸出單層 5 筆；`counts` 是篩選前總計
- **alert rules 裁剪**：`include_query: false` 時 `data` 不在輸出中；`true` 時每個 refId 只有 `{refId, datasourceUid, expr?, type?}`
- **`RESPONSE_TOO_LARGE`**：(a) `Content-Length` 預檢；(b) 無 `Content-Length` 的 streaming 逐塊累計——用 `ReadableStream` 分多塊餵，斷言 `reader.cancel()` 有被呼叫
- **timeout**：`vi.useFakeTimers()` + 永不 resolve 的 fetch → `REQUEST_TIMEOUT`
- **abort**：外部 `AbortController.abort()` → `REQUEST_ABORTED`（且不能被誤判成 timeout）
- **`INVALID_RESPONSE`**：`content-type: text/html`（反向代理登入頁）、合法 JSON 但頂層是陣列、破損 JSON

### `tests/tools.test.ts`

- 用 fake `ctx`（`{ tools: { register: vi.fn() } }`）收集工具定義
- 斷言註冊數量為 **6**，且名稱集合完全等於 6 個預期名稱
- 每個工具 `isConcurrencySafe() === true`
- snake_case → camelCase 轉接正確（用 stub client 記錄收到的參數物件）
- `render()` 回傳 `[{type:'text', text: JSON.stringify(value)}]` 且可被 `JSON.parse` 還原
- **locale 生效**：以 `locale: 'zh-TW'` 註冊 → 斷言 `grafana_query_range` 的 description 等於 `TRADITIONAL_CHINESE.queryRangeDescription`；tool **name 不變**（仍是 `grafana_query_range`）
- **description 與程式碼行為一致性**（registry 審核會比對）：對每個 locale 斷言 `grafana_query_range` 的 description 同時提到 step 與點數上限，`grafana_alert_state` 的 description 提到預設只回 firing/pending

### `tests/locales.test.ts`

- 四種語言的 `GrafanaMessages` 物件**鍵集合完全相同**（`Object.keys().sort()` 互比）
- `grafanaMessages(locale)` 對四個合法值各回對應物件
- `CONFIG_I18N` 涵蓋 7 個語系鍵，且每個物件的鍵集合都等於「6 個 config 欄位 + `$description`」
- 無空字串值

### CI

`ci.yml`：push / PR 觸發，跑 lint → typecheck → test --coverage → build。`release.yml` 如 §8-3。

---

## 10. 非目標（v0.1 明確不做）

1. **dashboard 搜尋、dashboard JSON 讀取、panel JSON 讀取**——panel JSON 又大又雜，對 agent 訊噪比差；讀到 panel 也不等於拿到數據。
2. **任何寫入操作**：不建立/修改/刪除 dashboard、datasource、alert rule、folder、annotation；不 silence、不 ack、不 pause alert rule。
3. **Loki 日誌查詢**（`/loki/api/v1/query_range`）——proxy 路徑同構、實作成本不高，但日誌的裁剪策略（行數、時間窗、label 選擇）與 metrics 完全不同，值得獨立設計。留給 v0.2 或另一個插件。
4. **Tempo / traces、Pyroscope / profiles**。
5. **`/api/ds/query` 與 Grafana dataframe 解析**（理由見 §2.2）。
6. **Prometheus metadata API**（`/api/v1/label/__name__/values`、`/api/v1/series`、`/api/v1/metadata`）——「有哪些 metric 可以查」很有用，但回應動輒上萬筆、裁剪策略要另外想。列為 v0.2 首選。
7. **舊 id 版 datasource proxy**（`/api/datasources/proxy/:id/*`）與 Grafana 8 以下。
8. **Grafana Cloud Access Policy token（`glc_`）與直連 Cloud Prometheus 端點**（`prometheus-prod-XX.grafana.net` + Basic auth）。v0.1 一律經由 stack 的 `/api/...`。
9. **多 org 切換**（`X-Grafana-Org-Id` header）。service account token 已綁定 org。
10. **自動重試 / 退避**。429 與 5xx 直接回報給 agent，由 agent 決定是否重試——唯讀插件不該在背後放大流量。
11. **回應快取**（datasource metadata cache 除外）。metrics 是即時資料，快取只會誤導。
12. **PromQL 語法驗證 / 補全 / 產生**。查詢字串原樣轉發，語法錯由 Prometheus 回報（並經 §6.2 透出）。
13. **alert 通知管道、contact point、notification policy、silence 清單**。
14. **Grafana 使用者 / 團隊 / 權限查詢**。
15. **datasource 白名單 / 黑名單**（`allowedDatasourceUids`）——這應由 service account 的 `datasources:uid:*` 細粒度權限收斂，在插件裡再做一層是重複的，且會給人虛假的安全感。README 教使用者用細粒度 scope。
16. **錯誤訊息 i18n**。錯誤訊息一律英文（§6.1）。

---

## 11. 上線前 live 驗證清單

單元測試全部 mock fetch，因此下列「Grafana 實際行為」的假設必須在真實環境跑過一次才能發版。**有可實測的 Grafana（自架 + Grafana Cloud 各一），因此以下全部為必跑項，非可選。**

執行方式：本機 `bun run build` 後，用一支臨時 script（不進 repo，或放 `scripts/smoke-dsh.sh`，照 `dsh-forge` 的做法）直接呼叫 client 方法，對自架與 Cloud 各跑一輪。

| # | 要驗證的假設 | 怎麼驗 | 不符時的回退 |
| --- | --- | --- | --- |
| L1 | uid proxy 路徑在自架與 Cloud 都可用，且回傳 Prometheus 原生 JSON（非 dataframe） | `grafana_query` 打 `up` | 若 Cloud 不通 → 記入 README 已知限制，不改設計 |
| L2 | sub-path baseUrl（`https://host/grafana/`）組出的 URL 正確 | 自架用 sub-path 反向代理跑一次 | 修 `normalizeBaseUrl` 或 endpoint join |
| L3 | PromQL 語法錯確實回 **HTTP 400** + `{"status":"error","errorType":"bad_data","error":...}` | 送 `up(` | 若回 422 而非 400 → §6.2 的透出條件放寬到「400 或 422」，並同步改 spec 與測試 |
| L4 | 超量 query 回 422（或 400）而非 200 | 送極大 range 的高基數 query | 依實際狀態碼調整 `UPSTREAM_QUERY_FAILED` 的映射表 |
| L5 | `/api/prometheus/grafana/api/v1/rules` 的 `state` 用哪套詞彙 | 建一條必觸發的測試規則後查詢 | 正規化邏輯已同時吃兩套，只需確認 `meta.stateVocabulary` 標對 |
| L6 | `/api/v1/provisioning/alert-rules` 在 `alert.provisioning:read` 下可讀，且 `data[].model.expr` 欄位路徑正確 | 用只有該權限的 service account 讀一次 | 若 `expr` 路徑不同 → 調整 §3.6 的摘要抽取；若權限名不同 → 修錯誤訊息與 README 權限表 |
| L7 | Cloud stack 的 `/api/datasources` 回傳筆數與 `grafanacloud-*` 命名，確認 filter + 分頁夠用 | Cloud 實測 | 若筆數 > 200 導致 cache 溢位 → 調高 `DATASOURCE_CACHE_MAX` |
| L8 | 非 Prometheus datasource 走 proxy 時實際回什麼狀態碼 | 指到一個 MySQL/Loki datasource | 依實際狀態碼補進 `DATASOURCE_TYPE_UNSUPPORTED` 的映射 |
| L9 | 舊 API key 與 service account token 都能通過 `Authorization: Bearer` | 兩種 token 各跑一次 `grafana_health` | 若舊 key 不通 → README 改為「僅支援 service account token」 |
| L10 | Cloud 的 rate limit 是否在正常使用下觸發 429 | 連續跑 20 次 query | 若容易觸發 → README 加註；設計不變（不做自動重試） |
| L11 | `maxResponseBytes` 在真實大回應下確實中止而非 OOM | 對 Cloud 送一個會回數 MB 的 query | 調整 streaming 讀取實作 |

驗證結果寫進 `docs/superpowers/specs/` 下的一份 verification note，並把 L3 / L5 / L8 的實測結論回填到本 spec 對應章節。

---

## 12. 決策紀錄

以下皆已定案，實作時不得再開放討論。

### 全域慣例（三個插件一致）

- **已定：runtime tool metadata 四語走 `config.locale`（`en` / `zh-TW` / `zh-CN` / `ja`，預設 `en`）** —— tool name 固定英文、description 與參數說明依 locale 切換，這是硬性專案慣例；只做 `CONFIG_I18N` 無法滿足「runtime tool metadata 也四語」。
- **已定：上游錯誤訊息僅在 HTTP 400 時透出，且限長 200 字元、只取結構化欄位、過濾疑似機密** —— 與 `dsh-sonarqube`「永不夾帶 body」不同，此處為刻意例外，理由是 query 語法錯誤若不回饋，agent 只能盲猜；完整規則見 §6.2。

### 本插件

- **已定（A1）：只支援 `/api/datasources/proxy/uid/:uid/*`，最低 Grafana 9.0** —— 舊 id 路徑已 deprecated 且官方文件不再列出，同時支援兩條路徑要多帶「uid 或 id」的參數語意與 fallback 邏輯，違反 Simplicity first。
- **已定（B1／即全域 G1）：新增 `config.locale` 欄位，走 `dsh-forge` 的 `createXxxTools(client, locale)` 形狀** —— 已在既有插件驗證可行，且滿足四語慣例。
- **已定（C1）：`datasource_uid` 必填** —— 明確可預測，且第一次 `grafana_list_datasources` 就把 datasource cache 填好，type 檢查才有依據；多一次工具呼叫遠優於猜錯 datasource 查出錯誤數據。
- **已定（D1）：`grafana_alert_state` 走 `/api/prometheus/grafana/api/v1/rules`** —— 一次拿到規則名稱、folder、state 與 instance，脈絡完整且格式好裁剪；Alertmanager v2 端點會丟失規則層脈絡。
- **已定（E1）：`step` 省略時自動降採樣、明確指定卻會超量時直接拒絕** —— 使用者沒指定時我們有權替他選；明確指定卻被偷改，agent 會拿到與它以為的不同解析度的資料而不自知，比報錯危險得多。
- **已定（F1）：加入第 6 個工具 `grafana_health`** —— 回應極小、約 15 行成本，是「連線與認證設定對不對」最快的診斷入口，也與 `dsh-sonarqube` 的 `sonarqube_system_status` 形狀一致。
- **已定（G1-maxSeries）：`maxSeries` 開放為 config 欄位，預設 100、範圍 1–1000** —— 這是唯一真的會因環境而異的裁剪參數（自架小環境 vs Cloud 大 stack），成本只有一行 Schemastery 宣告加一行驗證。
- **已定（H1）：不做 datasource 白名單/黑名單** —— 應由 service account 的 `datasources:uid:*` 細粒度權限收斂，插件內再做一層是重複且給人虛假的安全感；README 教使用者開細粒度 scope。
- **已定（I1）：測試用手寫 stub `fetchImplementation` + `jsonResponse()` helper，不導入 MSW** —— 與 `dsh-sonarqube` / `dsh-forge` 形狀一致，且 bounded-body 測試需要自訂 `ReadableStream`，MSW 反而礙事。
