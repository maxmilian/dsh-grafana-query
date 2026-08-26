# dsh-grafana-query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 從零建立 `dsh-grafana-query`——一個唯讀的 DeepSeek Harness 插件，讓 agent 透過 Grafana 的 datasource proxy 執行 PromQL（instant / range）並讀取 unified alerting 的規則與當前狀態。

**Architecture:** 七個 `src/` 檔案，職責單一、單向相依：`types.ts` ← `errors.ts` ← `config.ts` ← `client.ts` ← `tools.ts` ← `index.ts`，`locales.ts` 只被 `tools.ts` 與 `index.ts` 使用。`client.ts` 是唯一碰 HTTP 的檔案且不引用 cordis／dsh-tools（因此可獨立單測）；`tools.ts` 只做 snake_case ↔ camelCase 轉接與 locale 取值；`index.ts` 只做 Cordis 插件宣告。骨架整體複製自 `~/side/ankey/dsh-sonarqube`（同作者的唯讀插件標準形），`config.ts` / `errors.ts` / `locales.ts` 三塊複用度最高。

**Tech Stack:** TypeScript 5.9（NodeNext、strict）、Bun 1.3.5（套件管理與執行）、vitest 4（含 v8 coverage）、Biome 2.5（lint + format）、peer deps `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`。無 runtime 相依（只用 Web 標準的 `fetch` / `URL` / `AbortController`）。

**Spec:** `docs/superpowers/specs/2026-08-26-dsh-grafana-design.md`（本計畫每一項需求都出自該 spec，執行者必須兩份都讀）

## Global Constraints

以下數值一律照抄自 spec，不得自行調整：

- **套件名 / repo 名 / cordis patch id / `export const name`**：全部是 `dsh-grafana-query`（npm 上的 `dsh-grafana` 已被他人佔用）。**工具名前綴維持 `grafana_`**。
- **`package.json` 必須有 `dsh.bundle.patch` → `./cordis.patch.yml`**（registry 硬性要求，只宣告 `dsh.client` 會被退件）。
- **peerDependencies 的 `@deepseek-ai/*` 必須寫顯式 prerelease 分支**：`"@deepseek-ai/dsh-tools": "^0.1.0-rc.8 || ^0.1.1-rc.2"`。只寫 `^0.1.0-rc.8` 會被 node-semver 靜默排除 `0.1.1-rc.2`，使用者安裝直接 ERESOLVE。
- **`engines.node`**：`^22.19.0 || >=24.0.0`；**`packageManager`**：`bun@1.3.5`；**license**：MIT。
- **npm 帳號是 `maxhsu`，GitHub 帳號是 `maxmilian`**（兩者不同；`repository.url` 用 `maxmilian`）。
- **最低支援 Grafana 9.0**，只走 uid 版 datasource proxy `/api/datasources/proxy/uid/:uid/*`，不支援舊 id 版。
- **認證只有一種**：`Authorization: Bearer <token>`（service account token 與舊 API key 皆適用；`glc_` 開頭的 Cloud Access Policy token 不適用）。
- **所有工具 `isConcurrencySafe: () => true`**，輸出統一 `OUTPUT_SCHEMA`（`{ data, meta }`），render 成單一 JSON text。
- **錯誤訊息一律英文**，不隨 `locale` 變動。**tool description 與參數 description 一律依 `config.locale` 四語切換**（`en` / `zh-TW` / `zh-CN` / `ja`），**tool name 固定英文**。
- **錯誤永不帶入 token 或原始 response body**，唯一例外是 spec §6.2：只在上游 HTTP **400** 時透出 Prometheus 的結構化 `error` 欄位，上限 **200 字元**，且先跑 redaction。
- **Biome 設定 `noExcessiveCognitiveComplexity` 上限 10**。任何函式超過就必須拆小 helper——這會直接讓 `bun run lint` 紅燈。
- **四個驗證指令全綠才算完成**：`bun run lint`、`bun run typecheck`、`bun run test`、`bun run build`。
- **coverage 門檻 80%**（branches / functions / lines / statements），`src/types.ts` 排除。
- 骨架來源可直接讀取：`~/side/ankey/dsh-sonarqube`（主要）、`~/side/ankey/dsh-forge`（locale 形狀參考）。

---

## 檔案結構

| 檔案 | 責任 | 相依 | 由哪個 Task 建立 |
| --- | --- | --- | --- |
| `package.json` / `tsconfig.json` / `tsconfig.build.json` / `biome.json` / `vitest.config.ts` / `.gitignore` / `LICENSE` / `cordis.patch.yml` | 工具鏈與封裝宣告 | — | Task 1 |
| `src/types.ts` | 純型別：`JsonValue` / `JsonObject` / `JsonArray` / `ApiResult` / 五組工具參數介面 / `DatasourceMeta` | `@deepseek-ai/dsh-tools`（僅型別） | Task 1 |
| `src/errors.ts` | `GrafanaErrorCode`、`GrafanaApiError`、`createHttpError`、`createUpstreamError`（含 §6.2 redaction）、`safeHeader`、`inputError`、`configError` | `types.ts` | Task 3 |
| `src/config.ts` | 共用常數（timeout / bytes / maxSeries / 分頁上下界、`LOCALES`）、`resolveConfig`、`validateResolvedConfig`、`normalizeBaseUrl` | `errors.ts` | Task 2 |
| `src/client.ts` | 唯一碰 HTTP 的檔案：`GrafanaClient` 六個方法、共用 `#get()`、metadata cache 與降級表、duration parser、step ladder、所有裁剪 helper、純裁剪常數 | `config.ts` / `errors.ts` / `types.ts` | Task 4–11 |
| `src/locales.ts` | `GrafanaMessages` 介面 + 四語實作 + `grafanaMessages()`；`CONFIG_I18N`（7 語系鍵） | `config.ts`（`Locale` 型別） | Task 12 |
| `src/tools.ts` | `registerGrafanaTools(ctx, client, locale)`、`OUTPUT_SCHEMA`、六個 `defineTool()`、`renderJson` | `client.ts` / `locales.ts` / `types.ts` | Task 13 |
| `src/index.ts` | Cordis 入口：`name` / `inject` / Schemastery `Config` / `apply()` / re-export | 全部 | Task 14 |
| `tests/config.test.ts` / `errors.test.ts` / `client.test.ts` / `locales.test.ts` / `tools.test.ts` / `plugin.test.ts` | 對應單測 | — | 各 Task |
| `README.md` / `README.zh-TW.md` / `README.zh-CN.md` / `README.ja.md` | 四語說明文件 | — | Task 15 |
| `.github/workflows/ci.yml` / `release.yml` | CI 與發版 | — | Task 16 |

**為什麼 `client.ts` 不再拆更細**：spec §7 已定七檔結構，且 `dsh-sonarqube` 的 `client.ts` 是 405 行的單檔。本專案預估 ~460 行仍在同一量級；拆檔會讓 `#get()` 與各方法之間多出人工邊界，反而違反「files that change together live together」。Task 4–11 是**同一個檔案的漸進式建構**，每個 Task 只新增一個 public 方法與它的 helper。

---

## Task 1: 專案骨架與工具鏈

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `cordis.patch.yml`, `src/types.ts`

**Interfaces:**
- Consumes: 無（第一個 Task）
- Produces: `src/types.ts` 匯出 `JsonValue`、`JsonObject`、`JsonArray`、`ApiResult`、`ListDatasourcesParams`、`QueryParams`、`QueryRangeParams`、`AlertStateParams`、`ListAlertRulesParams`、`DatasourceMeta`

- [ ] **Step 1: 複製骨架設定檔並改名**

```bash
cd ~/side/ankey/dsh-grafana-query
SRC=~/side/ankey/dsh-sonarqube
cp "$SRC/tsconfig.json" "$SRC/tsconfig.build.json" "$SRC/biome.json" "$SRC/vitest.config.ts" "$SRC/.gitignore" "$SRC/LICENSE" .
mkdir -p src tests .github/workflows
```

`tsconfig.json` / `tsconfig.build.json` / `biome.json` / `.gitignore` / `LICENSE` **原封不動使用**（內容與套件名無關）。`vitest.config.ts` 也原封不動（`include: ['tests/**/*.test.ts']`、coverage 排除 `src/types.ts`、門檻 80）。

- [ ] **Step 2: 寫 `package.json`**

```json
{
  "name": "dsh-grafana-query",
  "version": "0.1.0",
  "description": "Read-only Grafana metrics and alert tools for DeepSeek Harness.",
  "homepage": "https://github.com/maxmilian/dsh-grafana-query#readme",
  "bugs": { "url": "https://github.com/maxmilian/dsh-grafana-query/issues" },
  "repository": { "type": "git", "url": "git+https://github.com/maxmilian/dsh-grafana-query.git" },
  "author": "maxmilian",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md",
    "README.zh-TW.md",
    "README.zh-CN.md",
    "README.ja.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "format": "biome format --write .",
    "lint": "biome check .",
    "prepare": "bun run build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "keywords": ["deepseek-harness", "dsh-plugin", "grafana", "prometheus", "promql", "observability"],
  "license": "MIT",
  "packageManager": "bun@1.3.5",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "publishConfig": { "access": "public" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.8 || ^0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.10",
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.8",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@types/node": "^24.10.1",
    "@vitest/coverage-v8": "^4.0.18",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- [ ] **Step 3: 寫 `cordis.patch.yml`**

```yaml
- insert:
    - id: dsh-grafana-query
      name: dsh-grafana-query
      config:
        baseUrl: ''
        token: ''
        locale: en
        requestTimeoutMs: 30000
        maxResponseBytes: 5242880
        maxSeries: 100
```

- [ ] **Step 4: 寫 `src/types.ts`**

```ts
import type { JsonValue as DshJsonValue } from '@deepseek-ai/dsh-tools'

/** The canonical lossless JSON value accepted by DeepSeek Harness tool output. */
export type JsonValue = DshJsonValue

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: JsonValue }

/** A JSON array. */
export type JsonArray = JsonValue[]

/** Canonical response returned by every Grafana client method. */
export interface ApiResult {
  readonly data: JsonValue
  readonly meta: JsonObject
}

/** Cached Grafana data source metadata used for pre-flight checks. */
export interface DatasourceMeta {
  readonly type: string
  readonly access: string
}

/** Shared client-side pagination selector. */
export interface PageParams {
  readonly page?: number
  readonly pageSize?: number
}

/** `grafana_list_datasources` request parameters. */
export interface ListDatasourcesParams extends PageParams {
  readonly type?: string
  readonly nameContains?: string
}

/** `grafana_query` request parameters. */
export interface QueryParams {
  readonly datasourceUid: string
  readonly query: string
  readonly time?: string
  readonly timeout?: string
}

/** `grafana_query_range` request parameters. */
export interface QueryRangeParams {
  readonly datasourceUid: string
  readonly query: string
  readonly start: string
  readonly end: string
  readonly step?: string
  readonly maxPoints?: number
}

/** `grafana_alert_state` request parameters. */
export interface AlertStateParams extends PageParams {
  readonly state?: readonly string[]
  readonly folderContains?: string
  readonly ruleContains?: string
  readonly includeInstances?: boolean
  readonly maxInstancesPerRule?: number
}

/** `grafana_list_alert_rules` request parameters. */
export interface ListAlertRulesParams extends PageParams {
  readonly folderUid?: string
  readonly ruleGroup?: string
  readonly titleContains?: string
  readonly includeQuery?: boolean
}
```

- [ ] **Step 5: 安裝相依並驗證工具鏈**

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun run test --passWithNoTests
```

Expected：四個指令全綠。`bun run build` 會產出 `lib/types.js` 與 `lib/types.d.ts`。`--passWithNoTests` 只有這一次需要，Task 2 起就有真測試。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold project toolchain and shared types"
```

---

## Task 2: `config.ts` — 設定解析與驗證

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `src/types.ts`（無直接使用，但同 repo）
- Produces:
  - 常數：`DEFAULT_REQUEST_TIMEOUT_MS = 30_000`、`MAX_REQUEST_TIMEOUT_MS = 300_000`、`DEFAULT_MAX_RESPONSE_BYTES = 5_242_880`、`MAX_RESPONSE_BYTES = 52_428_800`、`DEFAULT_MAX_SERIES = 100`、`MAX_SERIES_LIMIT = 1_000`、`DEFAULT_PAGE_SIZE = 20`、`MAX_PAGE_SIZE = 100`、`LOCALES = ['en','zh-TW','zh-CN','ja']`、`DEFAULT_LOCALE = 'en'`
  - 型別：`Locale`、`GrafanaConfig`、`ResolvedGrafanaConfig`
  - 函式：`resolveConfig(config?: GrafanaConfig, env?: NodeJS.ProcessEnv): ResolvedGrafanaConfig`、`validateResolvedConfig(config: ResolvedGrafanaConfig): ResolvedGrafanaConfig`

> **注意相依順序**：`config.ts` 需要 `configError()`，而它定義在 `errors.ts`（Task 3）。本 Task 先在 `config.ts` 內部**暫時**自行 `throw new Error(...)` 會讓 Task 3 得回頭改。改成：本 Task **先建立 `src/errors.ts` 的最小骨架**（只有 `GrafanaApiError` 類別與 `configError()`），Task 3 再把它補完。這樣兩個 Task 都能獨立綠燈。

- [ ] **Step 1: 建立 `src/errors.ts` 的最小骨架**

```ts
/** Stable error codes produced by the Grafana client. */
export type GrafanaErrorCode =
  | 'ALERTING_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'DATASOURCE_NOT_PROXYABLE'
  | 'DATASOURCE_TYPE_UNSUPPORTED'
  | 'GRAFANA_HTTP_ERROR'
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'QUERY_RANGE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'SERVER_ERROR'
  | 'UPSTREAM_QUERY_FAILED'

/** Safe structured details for a Grafana failure. */
export interface GrafanaApiErrorOptions {
  readonly code: GrafanaErrorCode
  readonly status?: number
  readonly retryAfter?: string
  readonly errorType?: string
  readonly upstreamMessage?: string
}

/** Structured API error that never embeds credentials or raw response bodies. */
export class GrafanaApiError extends Error {
  readonly code: GrafanaErrorCode
  readonly status?: number
  readonly retryAfter?: string
  readonly errorType?: string
  readonly upstreamMessage?: string

  /** Creates a safe Grafana API error. */
  constructor(message: string, options: GrafanaApiErrorOptions) {
    super(message)
    this.name = 'GrafanaApiError'
    this.code = options.code
    this.status = options.status
    this.retryAfter = options.retryAfter
    this.errorType = options.errorType
    this.upstreamMessage = options.upstreamMessage
  }

  /** Returns JSON-safe error details suitable for diagnostics. */
  toJSON(): Record<string, number | string | undefined> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      retryAfter: this.retryAfter,
      errorType: this.errorType,
      upstreamMessage: this.upstreamMessage,
    }
  }
}

/** Creates a configuration error with a stable prefix. */
export function configError(message: string): GrafanaApiError {
  return new GrafanaApiError(`Invalid Grafana configuration: ${message}`, { code: 'INVALID_CONFIG' })
}

/** Creates an input validation error with a stable prefix. */
export function inputError(message: string): GrafanaApiError {
  return new GrafanaApiError(`Invalid Grafana input: ${message}`, { code: 'INVALID_INPUT' })
}
```

- [ ] **Step 2: 寫失敗測試 `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SERIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveConfig,
} from '../src/config.js'
import { GrafanaApiError } from '../src/errors.js'

const VALID = { baseUrl: 'https://grafana.example.com', token: 'glsa_token' } as const

describe('resolveConfig', () => {
  it('prefers plugin config over environment variables', () => {
    const resolved = resolveConfig(
      { baseUrl: 'https://config.example.com/grafana', token: 'config-token' },
      { GRAFANA_URL: 'https://env.example.com', GRAFANA_TOKEN: 'env-token' },
    )

    expect(resolved).toMatchObject({
      baseUrl: 'https://config.example.com/grafana/',
      token: 'config-token',
      locale: 'en',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      maxSeries: DEFAULT_MAX_SERIES,
    })
  })

  it('falls back to environment variables', () => {
    const resolved = resolveConfig({}, { GRAFANA_URL: 'https://env.example.com/g', GRAFANA_TOKEN: 't' })
    expect(resolved.baseUrl).toBe('https://env.example.com/g/')
    expect(resolved.token).toBe('t')
  })

  it('normalizes repeated trailing slashes while keeping the sub-path', () => {
    const resolved = resolveConfig({ ...VALID, baseUrl: 'https://h.example.com/grafana////' }, {})
    expect(resolved.baseUrl).toBe('https://h.example.com/grafana/')
  })

  it.each([
    ['ftp://h.example.com'],
    ['https://user:pass@h.example.com'],
    ['https://h.example.com/?a=1'],
    ['https://h.example.com/#x'],
    ['not-a-url'],
  ])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => resolveConfig({ ...VALID, baseUrl }, {})).toThrow(GrafanaApiError)
  })

  it('requires baseUrl and token', () => {
    expect(() => resolveConfig({}, {})).toThrow(/baseUrl or GRAFANA_URL/)
    expect(() => resolveConfig({ baseUrl: 'https://h.example.com' }, {})).toThrow(/token or GRAFANA_TOKEN/)
  })

  it.each(['en', 'zh-TW', 'zh-CN', 'ja'] as const)('accepts locale %s', (locale) => {
    expect(resolveConfig({ ...VALID, locale }, {}).locale).toBe(locale)
  })

  it.each(['de', '', 'EN'])('rejects locale %s', (locale) => {
    expect(() => resolveConfig({ ...VALID, locale: locale as never }, {})).toThrow(/locale/)
  })

  it.each([
    ['requestTimeoutMs', 0],
    ['requestTimeoutMs', 300_001],
    ['requestTimeoutMs', 1.5],
    ['maxResponseBytes', 0],
    ['maxResponseBytes', 52_428_801],
    ['maxSeries', 0],
    ['maxSeries', 1_001],
  ])('rejects out-of-range %s = %s', (field, value) => {
    expect(() => resolveConfig({ ...VALID, [field]: value }, {})).toThrow(GrafanaApiError)
  })
})
```

- [ ] **Step 3: 跑測試確認紅燈**

Run: `bun run test tests/config.test.ts`
Expected: FAIL —「Cannot find module '../src/config.js'」

- [ ] **Step 4: 實作 `src/config.ts`**

以 `~/side/ankey/dsh-sonarqube/src/config.ts` 為底，套用以下差異：改名 `SonarQube*` → `Grafana*`、環境變數 `SONARQUBE_URL` / `SONARQUBE_TOKEN` → `GRAFANA_URL` / `GRAFANA_TOKEN`、新增 `locale` 與 `maxSeries` 兩欄與其驗證、新增分頁常數。`normalizeBaseUrl()` 與 `assertBoundedInteger()` 邏輯**一字不改**。

```ts
import { configError } from './errors.js'

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Maximum accepted per-request timeout in milliseconds. */
export const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000
/** Default maximum successful response body size in bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
/** Maximum accepted successful response body size in bytes. */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024
/** Default maximum number of series returned by a single query. */
export const DEFAULT_MAX_SERIES = 100
/** Maximum accepted value for maxSeries. */
export const MAX_SERIES_LIMIT = 1_000
/** Default page size for client-side pagination. */
export const DEFAULT_PAGE_SIZE = 20
/** Maximum accepted page size for client-side pagination. */
export const MAX_PAGE_SIZE = 100

/** Locales supported by tool metadata. */
export const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ja'] as const
/** Locale accepted by the plugin configuration. */
export type Locale = (typeof LOCALES)[number]
/** Locale used when none is configured. */
export const DEFAULT_LOCALE: Locale = 'en'

/** Runtime configuration accepted by the client and plugin. */
export interface GrafanaConfig {
  readonly baseUrl?: string
  readonly token?: string
  readonly locale?: Locale
  readonly requestTimeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxSeries?: number
}

/** Fully validated runtime configuration. */
export interface ResolvedGrafanaConfig {
  readonly baseUrl: string
  readonly token: string
  readonly locale: Locale
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly maxSeries: number
}

/** Resolves plugin config over environment variables and validates safe bounds. */
export function resolveConfig(
  config: GrafanaConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGrafanaConfig {
  return validateResolvedConfig({
    baseUrl: config.baseUrl?.trim() || env.GRAFANA_URL?.trim() || '',
    token: config.token?.trim() || env.GRAFANA_TOKEN?.trim() || '',
    locale: config.locale ?? DEFAULT_LOCALE,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxSeries: config.maxSeries ?? DEFAULT_MAX_SERIES,
  })
}

/** Validates and normalizes a fully specified client configuration. */
export function validateResolvedConfig(config: ResolvedGrafanaConfig): ResolvedGrafanaConfig {
  if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
    throw configError('baseUrl or GRAFANA_URL is required.')
  }
  if (typeof config.token !== 'string' || !config.token.trim()) {
    throw configError('token or GRAFANA_TOKEN is required.')
  }
  if (!LOCALES.includes(config.locale)) {
    throw configError(`locale must be one of ${LOCALES.join(', ')}.`)
  }
  assertBoundedInteger('requestTimeoutMs', config.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)
  assertBoundedInteger('maxResponseBytes', config.maxResponseBytes, MAX_RESPONSE_BYTES)
  assertBoundedInteger('maxSeries', config.maxSeries, MAX_SERIES_LIMIT)
  return { ...config, baseUrl: normalizeBaseUrl(config.baseUrl.trim()), token: config.token.trim() }
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw configError('baseUrl must be a valid HTTP or HTTPS URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw configError('baseUrl must be an HTTP(S) URL without embedded credentials.')
  }
  if (url.search || url.hash) {
    throw configError('baseUrl must not include a query string or fragment.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.toString()
}

function assertBoundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configError(`${name} must be an integer between 1 and ${maximum}.`)
  }
}
```

- [ ] **Step 5: 跑測試確認綠燈**

Run: `bun run test tests/config.test.ts`
Expected: PASS（全部案例）

- [ ] **Step 6: 跑完整驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add configuration resolution and validation"
```

---

## Task 3: `errors.ts` — HTTP 錯誤映射與上游訊息 redaction

**Files:**
- Modify: `src/errors.ts`（補完 Task 2 建立的骨架）
- Create: `tests/errors.test.ts`

**Interfaces:**
- Consumes: `GrafanaApiError` / `GrafanaErrorCode` / `configError` / `inputError`（Task 2 已建立）、`JsonValue`（`types.ts`）
- Produces:
  - `MAX_UPSTREAM_ERROR_CHARS = 200`
  - `createHttpError(status: number, retryAfter?: string): GrafanaApiError`
  - `createUpstreamError(status: number, body: JsonValue, token: string): GrafanaApiError`
  - `safeHeader(headers: Headers, name: string, token: string): string | undefined`

- [ ] **Step 1: 寫失敗測試 `tests/errors.test.ts`**

```ts
import { describe, expect, it } from 'vitest'

import { createHttpError, createUpstreamError, MAX_UPSTREAM_ERROR_CHARS, safeHeader } from '../src/errors.js'

const TOKEN = 'glsa_supersecret'
const BAD_DATA = { status: 'error', errorType: 'bad_data', error: 'parse error at char 5' }

describe('createHttpError', () => {
  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [405, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [418, 'GRAFANA_HTTP_ERROR'],
  ])('maps HTTP %s to %s', (status, code) => {
    expect(createHttpError(status).code).toBe(code)
  })

  it('carries Retry-After for rate limits', () => {
    expect(createHttpError(429, '30').retryAfter).toBe('30')
  })
})

describe('createUpstreamError', () => {
  it('exposes the upstream error only for HTTP 400', () => {
    expect(createUpstreamError(400, BAD_DATA, TOKEN).upstreamMessage).toBe('parse error at char 5')
    expect(createUpstreamError(422, BAD_DATA, TOKEN).upstreamMessage).toBeUndefined()
    expect(createUpstreamError(200, BAD_DATA, TOKEN).upstreamMessage).toBeUndefined()
  })

  it('always carries a whitelisted errorType and drops unknown ones', () => {
    expect(createUpstreamError(422, BAD_DATA, TOKEN).errorType).toBe('bad_data')
    expect(createUpstreamError(400, { ...BAD_DATA, errorType: 'weird' }, TOKEN).errorType).toBeUndefined()
  })

  it('ignores non-string and non-object bodies', () => {
    expect(createUpstreamError(400, 'plain text', TOKEN).upstreamMessage).toBeUndefined()
    expect(createUpstreamError(400, { ...BAD_DATA, error: { a: 1 } }, TOKEN).upstreamMessage).toBeUndefined()
  })

  it('truncates the upstream error at the character cap', () => {
    const error = 'x'.repeat(300)
    const result = createUpstreamError(400, { ...BAD_DATA, error }, TOKEN)
    expect(result.upstreamMessage).toHaveLength(MAX_UPSTREAM_ERROR_CHARS)
    expect(result.upstreamMessage?.endsWith('…')).toBe(true)
  })

  it('drops the message entirely when it contains the configured token', () => {
    const result = createUpstreamError(400, { ...BAD_DATA, error: `bad header ${TOKEN}` }, TOKEN)
    expect(result.upstreamMessage).toBeUndefined()
  })

  it.each([
    'leaked glsa_abcdefghij in query',
    'leaked glc_abcdefghij in query',
    'leaked eyJhbGciOiJIUzI1NiJ9 in query',
    'Authorization: Bearer abcdefghij failed',
  ])('redacts secret-looking fragments: %s', (error) => {
    const result = createUpstreamError(400, { ...BAD_DATA, error }, TOKEN)
    expect(result.upstreamMessage).toContain('[redacted]')
    expect(result.upstreamMessage).not.toMatch(/glsa_|glc_|eyJ/)
  })

  it('drops the message when redaction leaves too little signal', () => {
    const result = createUpstreamError(400, { ...BAD_DATA, error: 'glsa_abcdefghij' }, TOKEN)
    expect(result.upstreamMessage).toBeUndefined()
  })

  it('never serializes the token', () => {
    const result = createUpstreamError(400, { ...BAD_DATA, error: `x ${TOKEN} y` }, TOKEN)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})

describe('safeHeader', () => {
  it('rejects headers that echo the token or exceed the length cap', () => {
    const headers = new Headers({ 'x-a': TOKEN, 'x-b': 'y'.repeat(200), 'x-c': '30' })
    expect(safeHeader(headers, 'x-a', TOKEN)).toBeUndefined()
    expect(safeHeader(headers, 'x-b', TOKEN)).toBeUndefined()
    expect(safeHeader(headers, 'x-c', TOKEN)).toBe('30')
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/errors.test.ts`
Expected: FAIL —「createHttpError is not exported」

- [ ] **Step 3: 補完 `src/errors.ts`**

在既有骨架後追加。注意每個函式都要小於 Biome 的複雜度上限 10，因此 redaction 拆成三個小函式。

```ts
import type { JsonValue } from './types.js'

/** Maximum number of characters exposed from an upstream error message. */
export const MAX_UPSTREAM_ERROR_CHARS = 200

const ERROR_TYPES = new Set([
  'bad_data',
  'canceled',
  'execution',
  'internal',
  'not_acceptable',
  'timeout',
  'unavailable',
])

const SECRET_PATTERNS: readonly RegExp[] = [
  /glsa_\S+/g,
  /glc_\S+/g,
  /eyJ[A-Za-z0-9._-]{10,}/g,
  /(authorization|bearer|api[-_]?key|password|secret|token)\s*[:=]\s*\S+/gi,
]

/** Creates a safe error for an unsuccessful HTTP response. */
export function createHttpError(status: number, retryAfter?: string): GrafanaApiError {
  const descriptor = describeHttpError(status)
  return new GrafanaApiError(descriptor.message, { code: descriptor.code, status, retryAfter })
}

function describeHttpError(status: number): { code: GrafanaErrorCode; message: string } {
  if (status === 401) {
    return { code: 'AUTHENTICATION_FAILED', message: 'Grafana authentication failed. Check GRAFANA_TOKEN.' }
  }
  if (status === 403) {
    return { code: 'PERMISSION_DENIED', message: 'Grafana denied access to this resource.' }
  }
  if (status === 404 || status === 405) {
    return { code: 'NOT_FOUND', message: 'The requested Grafana resource was not found.' }
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: 'Grafana rate limit exceeded. Retry later.' }
  }
  if (status >= 500) {
    return { code: 'SERVER_ERROR', message: `Grafana server error (HTTP ${status}).` }
  }
  return { code: 'GRAFANA_HTTP_ERROR', message: `Grafana request failed (HTTP ${status}).` }
}

/** Creates an error for a Prometheus `status: "error"` response body. */
export function createUpstreamError(status: number, body: JsonValue, token: string): GrafanaApiError {
  const errorType = readErrorType(body)
  const upstreamMessage = status === 400 ? readUpstreamMessage(body, token) : undefined
  const label = errorType ? ` (${errorType})` : ''
  const detail = upstreamMessage ? `: ${upstreamMessage}` : ''
  return new GrafanaApiError(`Prometheus rejected the query${label}${detail}`, {
    code: 'UPSTREAM_QUERY_FAILED',
    status,
    errorType,
    upstreamMessage,
  })
}

function readErrorType(body: JsonValue): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const value = (body as Record<string, JsonValue>).errorType
  return typeof value === 'string' && ERROR_TYPES.has(value) ? value : undefined
}

function readUpstreamMessage(body: JsonValue, token: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const raw = (body as Record<string, JsonValue>).error
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  if (raw.includes(token)) return undefined
  return truncate(redact(raw))
}

function redact(value: string): string | undefined {
  let result = value
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]')
  const visible = result.replace(/\[redacted\]/g, '').replace(/\s+/g, '')
  return visible.length < 8 ? undefined : result
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length <= MAX_UPSTREAM_ERROR_CHARS) return value
  return `${value.slice(0, MAX_UPSTREAM_ERROR_CHARS - 1)}…`
}

/** Returns a response header only when it is short and does not echo the token. */
export function safeHeader(headers: Headers, name: string, token: string): string | undefined {
  const value = headers.get(name)?.trim()
  if (!value || value.length > 128 || value.includes(token)) return undefined
  return value
}
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/errors.test.ts`
Expected: PASS

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add HTTP error mapping and upstream message redaction"
```

---

## Task 4: `client.ts` 基礎設施 + `health()`

**Files:**
- Create: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: `ResolvedGrafanaConfig` / `resolveConfig` / `validateResolvedConfig`（`config.ts`）、`GrafanaApiError` / `createHttpError` / `createUpstreamError` / `safeHeader` / `inputError`（`errors.ts`）、`ApiResult` / `JsonValue` / `JsonObject` / `JsonArray`（`types.ts`）
- Produces:
  - `type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>`
  - `class GrafanaClient { constructor(config: ResolvedGrafanaConfig, fetchImplementation?: FetchImplementation); health(signal?: AbortSignal): Promise<ApiResult> }`
  - `createGrafanaClient(config?: GrafanaConfig, env?: NodeJS.ProcessEnv, fetchImplementation?: FetchImplementation): GrafanaClient`
  - private `#get(endpoint: string, query: URLSearchParams, signal?: AbortSignal): Promise<JsonValue>`——回傳**頂層物件或陣列**（spec §6.3）

- [ ] **Step 1: 寫失敗測試 `tests/client.test.ts`（本 Task 的部分）**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGrafanaClient, GrafanaClient } from '../src/client.js'
import type { GrafanaApiError } from '../src/errors.js'

type MockFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const BASE_CONFIG = {
  baseUrl: 'https://grafana.example.com/grafana/',
  token: 'glsa_secret',
  locale: 'en',
  requestTimeoutMs: 1_000,
  maxResponseBytes: 10_000,
  maxSeries: 100,
} as const

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function clientWith(fetchImpl: MockFetch, overrides: Partial<typeof BASE_CONFIG> = {}) {
  return new GrafanaClient({ ...BASE_CONFIG, ...overrides }, fetchImpl)
}

async function captureError(promise: Promise<unknown>): Promise<GrafanaApiError> {
  try {
    await promise
    throw new Error('expected the call to reject')
  } catch (error) {
    return error as GrafanaApiError
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('health', () => {
  it('calls /api/health under the configured sub-path with a bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ database: 'ok', version: '11.3.0', commit: 'abc' }))
    const result = await clientWith(fetchImpl).health()

    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit]
    expect(url.toString()).toBe('https://grafana.example.com/grafana/api/health')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer glsa_secret')
    expect(result).toEqual({ data: { database: 'ok', version: '11.3.0' }, meta: {} })
  })

  it('maps HTTP failures to stable codes without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const error = await captureError(clientWith(fetchImpl).health())

    expect(error.code).toBe('AUTHENTICATION_FAILED')
    expect(JSON.stringify(error)).not.toContain('glsa_secret')
    expect(error.message).not.toContain('glsa_secret')
  })

  it.each([
    ['text/html', '<html>login</html>'],
    ['application/json', '{oops'],
  ])('rejects unusable %s responses', async (contentType, body) => {
    const fetchImpl = vi.fn(async () => new Response(body, { headers: { 'content-type': contentType } }))
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('INVALID_RESPONSE')
  })

  it.each([['"ok"'], ['42'], ['null'], ['true']])('rejects scalar JSON top level %s', async (body) => {
    const fetchImpl = vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } }))
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('INVALID_RESPONSE')
  })

  it('rejects an array where an object is expected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ database: 'ok' }]))
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('INVALID_RESPONSE')
  })

  it('reports a timeout instead of a network error', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const promise = captureError(clientWith(fetchImpl).health())
    await vi.advanceTimersByTimeAsync(1_001)
    expect((await promise).code).toBe('REQUEST_TIMEOUT')
  })

  it('reports caller cancellation as REQUEST_ABORTED', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const promise = captureError(clientWith(fetchImpl).health(controller.signal))
    controller.abort()
    expect((await promise).code).toBe('REQUEST_ABORTED')
  })

  it('reports unreachable hosts as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('NETWORK_ERROR')
  })

  it('rejects bodies larger than maxResponseBytes via Content-Length', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '20000' },
        }),
    )
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('RESPONSE_TOO_LARGE')
  })

  it('cancels a streaming body that exceeds maxResponseBytes', async () => {
    const cancel = vi.fn()
    const chunk = new TextEncoder().encode('x'.repeat(600))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel,
    })
    const fetchImpl = vi.fn(
      async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    )
    const error = await captureError(clientWith(fetchImpl, { maxResponseBytes: 1_000 }).health())

    expect(error.code).toBe('RESPONSE_TOO_LARGE')
    expect(cancel).toHaveBeenCalled()
  })

  it('creates a client from environment variables', () => {
    const client = createGrafanaClient(
      {},
      { GRAFANA_URL: 'https://g.example.com', GRAFANA_TOKEN: 't' },
      vi.fn(),
    )
    expect(client).toBeInstanceOf(GrafanaClient)
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts`
Expected: FAIL —「Cannot find module '../src/client.js'」

- [ ] **Step 3: 實作 `src/client.ts` 的基礎設施與 `health()`**

以 `~/side/ankey/dsh-sonarqube/src/client.ts` 的 `#get` / `#readResponse` / `createRequestContext` / `normalizeRequestError` / `readBoundedBody` / `isJsonContentType` 為底，套用兩處差異：(a) `parseJsonObject` 改為 `parseJsonValue`，**接受頂層物件或陣列**、只有 scalar 才丟 `INVALID_RESPONSE`；(b) header 不再讀 SonarQube 專屬的 token 過期欄位。

```ts
import type { GrafanaConfig, ResolvedGrafanaConfig } from './config.js'
import { resolveConfig, validateResolvedConfig } from './config.js'
import { createHttpError, GrafanaApiError, safeHeader } from './errors.js'
import type { ApiResult, JsonArray, JsonObject, JsonValue } from './types.js'

export { resolveConfig }

/** Injectable fetch implementation, used by tests. */
export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface RequestContext {
  readonly controller: AbortController
  readonly dispose: () => void
  readonly didTimeout: () => boolean
}

/** Read-only HTTP client for the Grafana HTTP API and its Prometheus data source proxy. */
export class GrafanaClient {
  readonly #config: ResolvedGrafanaConfig
  readonly #fetch: FetchImplementation

  /** Creates a client from resolved configuration. */
  constructor(config: ResolvedGrafanaConfig, fetchImplementation: FetchImplementation = fetch) {
    this.#config = validateResolvedConfig(config)
    this.#fetch = fetchImplementation
  }

  /** Returns the Grafana instance health summary. */
  async health(signal?: AbortSignal): Promise<ApiResult> {
    const body = expectObject(await this.#get('api/health', new URLSearchParams(), signal))
    return { data: { database: body.database ?? null, version: body.version ?? null }, meta: {} }
  }

  async #get(endpoint: string, query: URLSearchParams, signal?: AbortSignal): Promise<JsonValue> {
    const url = new URL(endpoint, this.#config.baseUrl)
    url.search = query.toString()
    const context = createRequestContext(signal, this.#config.requestTimeoutMs)
    try {
      const response = await this.#fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#config.token}` },
        method: 'GET',
        signal: context.controller.signal,
      })
      return await this.#readResponse(response)
    } catch (error: unknown) {
      throw normalizeRequestError(error, signal, context, this.#config.requestTimeoutMs)
    } finally {
      context.dispose()
    }
  }

  async #readResponse(response: Response): Promise<JsonValue> {
    if (!response.ok) {
      await response.body?.cancel()
      throw createHttpError(response.status, safeHeader(response.headers, 'Retry-After', this.#config.token))
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!isJsonContentType(contentType)) {
      await response.body?.cancel()
      throw invalidResponse('Grafana returned a non-JSON response.')
    }
    return parseJsonValue(await readBoundedBody(response, this.#config.maxResponseBytes))
  }
}

/** Creates a client using plugin config over environment variables. */
export function createGrafanaClient(
  config: GrafanaConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): GrafanaClient {
  return new GrafanaClient(resolveConfig(config, env), fetchImplementation)
}

function invalidResponse(message: string): GrafanaApiError {
  return new GrafanaApiError(message, { code: 'INVALID_RESPONSE' })
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(';', 1)[0]?.trim()
  return (
    mediaType === 'application/json' ||
    (mediaType?.startsWith('application/') === true && mediaType.endsWith('+json'))
  )
}

function parseJsonValue(text: string): JsonValue {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidResponse('Grafana returned invalid JSON.')
  }
  if (typeof value !== 'object' || value === null) {
    throw invalidResponse('Grafana returned an unexpected JSON value.')
  }
  return value as JsonValue
}

/** Narrows a parsed body to a JSON object or fails with INVALID_RESPONSE. */
export function expectObject(value: JsonValue): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidResponse('Grafana returned an unexpected JSON shape.')
  }
  return value as JsonObject
}

/** Narrows a parsed body to a JSON array or fails with INVALID_RESPONSE. */
export function expectArray(value: JsonValue): JsonArray {
  if (!Array.isArray(value)) {
    throw invalidResponse('Grafana returned an unexpected JSON shape.')
  }
  return value
}
```

`createRequestContext` / `normalizeRequestError` / `readBoundedBody` **逐字複製** `dsh-sonarqube/src/client.ts` 的對應函式，只改錯誤類別名與訊息文字（`SonarQube` → `Grafana`）：

```ts
function createRequestContext(signal: AbortSignal | undefined, timeoutMs: number): RequestContext {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    controller,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

function normalizeRequestError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  context: RequestContext,
  timeoutMs: number,
): GrafanaApiError {
  if (error instanceof GrafanaApiError) return error
  if (context.didTimeout()) {
    return new GrafanaApiError(`Grafana request timed out after ${timeoutMs} ms.`, {
      code: 'REQUEST_TIMEOUT',
    })
  }
  if (callerSignal?.aborted) {
    return new GrafanaApiError('Grafana request was cancelled.', { code: 'REQUEST_ABORTED' })
  }
  return new GrafanaApiError('Unable to reach the Grafana server.', { code: 'NETWORK_ERROR' })
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > maximum) {
    await response.body?.cancel()
    throw responseTooLarge(maximum)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel()
      throw responseTooLarge(maximum)
    }
    text += decoder.decode(value, { stream: true })
  }
}

function responseTooLarge(maximum: number): GrafanaApiError {
  return new GrafanaApiError(`Grafana response exceeded the configured maximum of ${maximum} bytes.`, {
    code: 'RESPONSE_TOO_LARGE',
  })
}
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/client.test.ts`
Expected: PASS

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add Grafana HTTP client core and health tool backend"
```

---

## Task 5: `listDatasources()` — 白名單、篩選、分頁、metadata cache

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `#get` / `expectArray`、`DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE`（`config.ts`）、`ListDatasourcesParams` / `DatasourceMeta`（`types.ts`）
- Produces: `listDatasources(params: ListDatasourcesParams, signal?: AbortSignal): Promise<ApiResult>`；private `#datasourceCache: Map<string, DatasourceMeta>`；輸出 `data` 形狀 `{ datasources: Array<{uid,name,type,isDefault,access,readOnly,url?}> }`、`meta` 形狀 `{ total, page, pageSize }`（**無 `truncated`**）

- [ ] **Step 1: 寫失敗測試（追加到 `tests/client.test.ts`）**

```ts
const DATASOURCES = [
  {
    uid: 'prom-1',
    name: 'Prometheus Prod',
    type: 'prometheus',
    isDefault: true,
    access: 'proxy',
    readOnly: false,
    url: 'https://user:pass@prom.example.com',
    password: 'hunter2',
    basicAuthPassword: 'hunter2',
    secureJsonFields: { httpHeaderValue1: true },
    jsonData: { httpMethod: 'POST' },
    typeLogoUrl: 'public/img/prom.svg',
  },
  { uid: 'loki-1', name: 'Loki', type: 'loki', isDefault: false, access: 'proxy', readOnly: false, url: 'https://loki.example.com' },
  { uid: 'browser-1', name: 'Direct', type: 'prometheus', isDefault: false, access: 'direct', readOnly: true, url: 'https://direct.example.com' },
]

describe('listDatasources', () => {
  it('whitelists safe fields and strips credentials from the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    const result = await clientWith(fetchImpl).listDatasources({})
    const serialized = JSON.stringify(result)

    expect(serialized).not.toMatch(/password|basicAuthPassword|secureJsonFields|jsonData|typeLogoUrl|hunter2/)
    expect((result.data as { datasources: unknown[] }).datasources[0]).toEqual({
      uid: 'prom-1',
      name: 'Prometheus Prod',
      type: 'prometheus',
      isDefault: true,
      access: 'proxy',
      readOnly: false,
      url: 'https://prom.example.com/',
    })
  })

  it('omits the URL for direct-access data sources', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    const result = await clientWith(fetchImpl).listDatasources({ nameContains: 'direct' })
    expect((result.data as { datasources: Record<string, unknown>[] }).datasources[0]).not.toHaveProperty('url')
  })

  it('filters by type and name before paginating', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    const result = await clientWith(fetchImpl).listDatasources({ type: 'PROMETHEUS', pageSize: 1, page: 2 })

    expect(result.meta).toEqual({ total: 2, page: 2, pageSize: 1 })
    expect(result.meta).not.toHaveProperty('truncated')
    const uids = (result.data as { datasources: { uid: string }[] }).datasources.map((d) => d.uid)
    expect(uids).toEqual(['browser-1'])
  })

  it('accepts a top-level JSON array without raising INVALID_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await expect(clientWith(fetchImpl).listDatasources({})).resolves.toMatchObject({ meta: { total: 0 } })
  })

  it.each([
    [{ page: 0 }],
    [{ pageSize: 0 }],
    [{ pageSize: 101 }],
    [{ nameContains: 'x'.repeat(201) }],
  ])('rejects invalid pagination or filters %o', async (params) => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    expect((await captureError(clientWith(fetchImpl).listDatasources(params))).code).toBe('INVALID_INPUT')
  })
})
```

> 說明：`prom-1` 與 `browser-1` 兩筆命中 `type=prometheus`（大小寫不敏感），`pageSize: 1, page: 2` 因此取到第二筆 `browser-1`。

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t listDatasources`
Expected: FAIL —「client.listDatasources is not a function」

- [ ] **Step 3: 實作**

在 `GrafanaClient` 加入欄位與方法，並新增純函式 helper（每個都遠低於複雜度 10）。

```ts
  readonly #datasourceCache = new Map<string, DatasourceMeta>()

  /** Lists data sources with safe fields only, filtered and paginated client-side. */
  async listDatasources(params: ListDatasourcesParams, signal?: AbortSignal): Promise<ApiResult> {
    const page = assertPage(params.page)
    const pageSize = assertPageSize(params.pageSize)
    if (params.nameContains !== undefined) assertText('nameContains', params.nameContains, 200)
    if (params.type !== undefined) assertText('type', params.type, 100)

    const raw = expectArray(await this.#get('api/datasources', new URLSearchParams(), signal))
    const all = raw.filter(isJsonObject).map(readDatasource)
    for (const entry of all) this.#datasourceCache.set(entry.uid, { type: entry.type, access: entry.access })

    const matched = all.filter((entry) => matchesDatasource(entry, params))
    const start = (page - 1) * pageSize
    return {
      data: { datasources: matched.slice(start, start + pageSize).map(toPublicDatasource) },
      meta: { total: matched.length, page, pageSize },
    }
  }
```

```ts
interface DatasourceRecord {
  readonly uid: string
  readonly name: string
  readonly type: string
  readonly isDefault: boolean
  readonly access: string
  readonly readOnly: boolean
  readonly url?: string
}

function readDatasource(entry: JsonObject): DatasourceRecord {
  return {
    uid: readString(entry.uid) ?? '',
    name: readString(entry.name) ?? '',
    type: readString(entry.type) ?? '',
    isDefault: entry.isDefault === true,
    access: readString(entry.access) ?? '',
    readOnly: entry.readOnly === true,
    url: sanitizeUrl(readString(entry.url)),
  }
}

function toPublicDatasource(entry: DatasourceRecord): JsonObject {
  const base: JsonObject = {
    uid: entry.uid,
    name: entry.name,
    type: entry.type,
    isDefault: entry.isDefault,
    access: entry.access,
    readOnly: entry.readOnly,
  }
  if (entry.access !== 'direct' && entry.url) base.url = entry.url
  return base
}

function matchesDatasource(entry: DatasourceRecord, params: ListDatasourcesParams): boolean {
  if (params.type && entry.type.toLowerCase() !== params.type.toLowerCase()) return false
  if (params.nameContains && !entry.name.toLowerCase().includes(params.nameContains.toLowerCase())) {
    return false
  }
  return true
}

function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertText(name: string, value: string, maximum: number): void {
  if (!value.trim() || value.length > maximum) {
    throw inputError(`${name} must contain 1-${maximum} characters.`)
  }
}

function assertPage(value = 1): number {
  if (!Number.isSafeInteger(value) || value < 1) throw inputError('page must be a positive integer.')
  return value
}

function assertPageSize(value = DEFAULT_PAGE_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw inputError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`)
  }
  return value
}
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/client.test.ts`
Expected: PASS（含 Task 4 的既有案例）

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add data source listing with field whitelist and metadata cache"
```

---

## Task 6: duration parser 與 step ladder（純函式）

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: `inputError`（`errors.ts`）
- Produces（全部 export，供測試直接呼叫）：
  - `STEP_LADDER_SECONDS: readonly number[]`
  - `parseDurationMs(name: string, value: string): number`
  - `parseStepSeconds(value: string): number`
  - `chooseStepSeconds(rangeSeconds: number, maxPoints: number): number`

- [ ] **Step 1: 寫失敗測試（追加）**

```ts
import { chooseStepSeconds, parseDurationMs, parseStepSeconds } from '../src/client.js'

describe('duration parsing', () => {
  it.each([
    ['30', 30_000],
    ['500ms', 500],
    ['15s', 15_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
  ])('parses %s', (value, expected) => {
    expect(parseDurationMs('timeout', value)).toBe(expected)
  })

  it.each(['1h30m', '1.5h', '-5s', '1y', '', 'abc', '10 s'])('rejects %s', (value) => {
    expect(() => parseDurationMs('timeout', value)).toThrow(/timeout/)
  })

  it.each(['500ms', '1000ms'])('rejects %s as a step because ms is not allowed', (value) => {
    expect(() => parseStepSeconds(value)).toThrow(/ms/)
  })

  it.each([
    ['15s', 15],
    ['5m', 300],
    ['1h', 3_600],
    ['60', 60],
  ])('parses step %s into seconds', (value, expected) => {
    expect(parseStepSeconds(value)).toBe(expected)
  })
})

describe('chooseStepSeconds', () => {
  it.each([
    [60, 200, 1],
    [1_000, 200, 5],
    [3_600, 200, 30],
    [86_400, 200, 600],
    [7 * 86_400, 200, 3_600],
    [31 * 86_400, 200, 21_600],
  ])('picks the ladder step for range %s and %s points', (rangeSeconds, maxPoints, expected) => {
    expect(chooseStepSeconds(rangeSeconds, maxPoints)).toBe(expected)
  })

  it('falls back to the exact required step beyond one day', () => {
    expect(chooseStepSeconds(31 * 86_400, 2)).toBe(Math.ceil((31 * 86_400) / 2))
  })
})
```

> 每一列的算式：`ceil(rangeSeconds / maxPoints)` 求出 `requiredStep`，再取梯級中第一個 ≥ 它的值。例如最後一列 `ceil(2678400 / 200) = 13392`，梯級中第一個 ≥ 13392 的是 `21600`（6h）。最後一個測試 `ceil(2678400 / 2) = 1339200` 超過梯級最大值 `86400`，因此直接回傳 `1339200`。

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t duration`
Expected: FAIL —「parseDurationMs is not exported」

- [ ] **Step 3: 實作**

```ts
/** Ladder of human-friendly step values, in seconds. */
export const STEP_LADDER_SECONDS = [
  1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 21_600, 43_200, 86_400,
] as const

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d|w)?$/
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** Parses a Prometheus-style duration (or a bare integer of seconds) into milliseconds. */
export function parseDurationMs(name: string, value: string): number {
  const match = DURATION_PATTERN.exec(value.trim())
  if (!match?.[1]) {
    throw inputError(
      `${name} must be an integer number of seconds or a single value with unit ms, s, m, h, d, or w (for example 30s).`,
    )
  }
  const unit = match[2] ?? 's'
  return Number(match[1]) * (UNIT_MS[unit] as number)
}

/** Parses a step value into whole seconds, rejecting sub-second units. */
export function parseStepSeconds(value: string): number {
  if (value.trim().endsWith('ms')) {
    throw inputError('step does not accept the ms unit; use whole seconds or a larger unit.')
  }
  const seconds = parseDurationMs('step', value) / 1_000
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw inputError('step must be a whole number of seconds and at least 1 second.')
  }
  return seconds
}

/** Picks the smallest ladder step that keeps a range under the point budget. */
export function chooseStepSeconds(rangeSeconds: number, maxPoints: number): number {
  const required = Math.ceil(rangeSeconds / maxPoints)
  return STEP_LADDER_SECONDS.find((candidate) => candidate >= required) ?? required
}
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add duration parsing and adaptive step selection"
```

---

## Task 7: metadata 前置檢查與 proxy 404 判別

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `#get`、Task 5 的 `#datasourceCache`
- Produces: private `#datasourceMeta(uid: string, signal?: AbortSignal): Promise<DatasourceMeta | undefined>`（回 `undefined` 代表「降級：metadata 不可得」）；private `#proxyGet(uid, path, query, signal): Promise<JsonValue>`——依 metadata 是否可得決定 404/405 的錯誤碼

行為表（spec §2.3，實作時逐列對照）：

| metadata 請求結果 | 處置 | 寫 cache |
| --- | --- | --- |
| 200 物件 | 回傳 `{type, access}` | 是 |
| 401 | 拋 `AUTHENTICATION_FAILED` | 否 |
| 404 | 拋 `NOT_FOUND` | 否 |
| 403 / timeout / 網路 / 非 JSON / 其他非 2xx | 回 `undefined`（降級） | 否 |

- [ ] **Step 1: 寫失敗測試（追加）**

```ts
const PROM_META = { uid: 'prom-1', name: 'P', type: 'prometheus', access: 'proxy' }
const VECTOR_OK = { status: 'success', data: { resultType: 'vector', result: [] } }

function routed(routes: Record<string, () => Response>): MockFetch {
  return vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    const handler = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1]
    if (!handler) throw new Error(`unexpected request to ${path}`)
    return handler()
  })
}

describe('data source pre-flight checks', () => {
  it('rejects non-Prometheus data sources without issuing the query', async () => {
    const fetchImpl = routed({ '/api/datasources/uid/loki-1': () => jsonResponse({ type: 'loki', access: 'proxy' }) })
    const error = await captureError(clientWith(fetchImpl).query({ datasourceUid: 'loki-1', query: 'up' }))

    expect(error.code).toBe('DATASOURCE_TYPE_UNSUPPORTED')
    expect(error.message).toContain('loki')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects direct-access data sources without issuing the query', async () => {
    const fetchImpl = routed({ '/api/datasources/uid/d-1': () => jsonResponse({ type: 'prometheus', access: 'direct' }) })
    expect((await captureError(clientWith(fetchImpl).query({ datasourceUid: 'd-1', query: 'up' }))).code).toBe(
      'DATASOURCE_NOT_PROXYABLE',
    )
  })

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [404, 'NOT_FOUND'],
  ])('propagates metadata HTTP %s as %s', async (status, code) => {
    const fetchImpl = routed({ '/api/datasources/uid/x': () => new Response('', { status }) })
    expect((await captureError(clientWith(fetchImpl).query({ datasourceUid: 'x', query: 'up' }))).code).toBe(code)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when metadata is forbidden and still runs the query', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => jsonResponse(VECTOR_OK),
    })
    await expect(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })).resolves.toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not cache a degraded lookup', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => jsonResponse(VECTOR_OK),
    })
    const client = clientWith(fetchImpl)
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('caches successful metadata for the lifetime of the client', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(VECTOR_OK),
    })
    const client = clientWith(fetchImpl)
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps a proxy 404 to a type error when metadata succeeded', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => new Response('', { status: 404 }),
    })
    expect((await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }))).code).toBe(
      'DATASOURCE_TYPE_UNSUPPORTED',
    )
  })

  it('maps a proxy 404 to NOT_FOUND when metadata was unavailable', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => new Response('', { status: 404 }),
    })
    const error = await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }))

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toMatch(/uid/i)
    expect(error.message).toMatch(/Prometheus/i)
  })

  it.each([['bad uid!'], [''], ['x'.repeat(101)]])('rejects malformed uid %s', async (uid) => {
    const fetchImpl = vi.fn()
    expect((await captureError(clientWith(fetchImpl).query({ datasourceUid: uid, query: 'up' }))).code).toBe(
      'INVALID_INPUT',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t 'pre-flight'`
Expected: FAIL —「client.query is not a function」（`query()` 在 Task 8 才實作，因此本 Task 的測試會與 Task 8 一起轉綠；先實作本 Task 的兩個 private 方法，Task 8 立刻使用）

- [ ] **Step 3: 實作**

```ts
const UID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

  async #datasourceMeta(uid: string, signal?: AbortSignal): Promise<DatasourceMeta | undefined> {
    const cached = this.#datasourceCache.get(uid)
    if (cached) return cached
    try {
      const body = expectObject(await this.#get(`api/datasources/uid/${uid}`, new URLSearchParams(), signal))
      const meta = { type: readString(body.type) ?? '', access: readString(body.access) ?? '' }
      this.#datasourceCache.set(uid, meta)
      return meta
    } catch (error: unknown) {
      if (error instanceof GrafanaApiError && FATAL_META_CODES.has(error.code)) throw error
      return undefined
    }
  }

  async #proxyGet(
    uid: string,
    path: string,
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    assertUid(uid)
    const meta = await this.#datasourceMeta(uid, signal)
    if (meta) assertProxyable(uid, meta)
    try {
      return await this.#get(`api/datasources/proxy/uid/${uid}/${path}`, query, signal)
    } catch (error: unknown) {
      throw translateProxyError(error, uid, meta)
    }
  }
```

```ts
const FATAL_META_CODES = new Set<GrafanaErrorCode>(['AUTHENTICATION_FAILED', 'NOT_FOUND'])

function assertUid(uid: string): void {
  if (!UID_PATTERN.test(uid)) {
    throw inputError('datasourceUid must be 1-100 letters, digits, underscores, or hyphens.')
  }
}

function assertProxyable(uid: string, meta: DatasourceMeta): void {
  if (meta.type.toLowerCase() !== 'prometheus') {
    throw new GrafanaApiError(
      `Data source ${uid} has type "${meta.type}"; this plugin only supports Prometheus-compatible data sources.`,
      { code: 'DATASOURCE_TYPE_UNSUPPORTED' },
    )
  }
  if (meta.access === 'direct') {
    throw new GrafanaApiError(
      `Data source ${uid} uses browser (direct) access and cannot be proxied by Grafana.`,
      { code: 'DATASOURCE_NOT_PROXYABLE' },
    )
  }
}

function translateProxyError(error: unknown, uid: string, meta: DatasourceMeta | undefined): unknown {
  if (!(error instanceof GrafanaApiError) || error.code !== 'NOT_FOUND') return error
  if (meta) {
    return new GrafanaApiError(
      `Data source ${uid} did not answer the Prometheus query API; it is probably not Prometheus-compatible.`,
      { code: 'DATASOURCE_TYPE_UNSUPPORTED', status: error.status },
    )
  }
  return new GrafanaApiError(
    `Data source ${uid} was not found, or it is not a Prometheus-compatible data source. Run grafana_list_datasources to confirm the uid and type.`,
    { code: 'NOT_FOUND', status: error.status },
  )
}
```

- [ ] **Step 4: 暫時驗證**

Run: `bun run typecheck && bun run lint`
Expected: PASS。`bun run test` 此時 `pre-flight` 段仍紅，Task 8 會轉綠——**這是唯一允許跨 Task 停留在紅燈的地方**，因為兩者共用同一個 public 方法。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add data source pre-flight checks and proxy error disambiguation"
```

---

## Task 8: `query()` — instant query

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `#proxyGet`、`QueryParams`、`createUpstreamError`
- Produces: `query(params: QueryParams, signal?: AbortSignal): Promise<ApiResult>`；`data` 形狀 `{ resultType, result }`；`meta` 形狀 `{ seriesReturned, seriesTotal, truncated, warnings?, hint? }`；private `#readPromResult(body, status)`（Task 9 共用）

- [ ] **Step 1: 寫失敗測試（追加）**

```ts
function vector(count: number) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: Array.from({ length: count }, (_, index) => ({
        metric: { __name__: 'up', instance: `host-${index}` },
        value: [1_700_000_000, '1'],
      })),
    },
  }
}

describe('query', () => {
  it('builds the uid proxy URL and forwards the PromQL expression', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(vector(1)),
    })
    await clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up', time: '1700000000' })

    const url = new URL(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1][0]))
    expect(url.pathname).toBe('/grafana/api/datasources/proxy/uid/prom-1/api/v1/query')
    expect(url.searchParams.get('query')).toBe('up')
    expect(url.searchParams.get('time')).toBe('1700000000')
  })

  it('truncates series beyond maxSeries and records the total', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(vector(150)),
    })
    const result = await clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })

    expect((result.data as { result: unknown[] }).result).toHaveLength(100)
    expect(result.meta).toMatchObject({ seriesReturned: 100, seriesTotal: 150, truncated: true })
    expect(result.meta.hint).toBeTypeOf('string')
  })

  it('honours a lowered maxSeries from configuration', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(vector(150)),
    })
    const result = await clientWith(fetchImpl, { maxSeries: 5 }).query({ datasourceUid: 'prom-1', query: 'up' })
    expect((result.data as { result: unknown[] }).result).toHaveLength(5)
  })

  it('exposes the upstream error for HTTP 400 only', async () => {
    const body = { status: 'error', errorType: 'bad_data', error: 'parse error at char 3' }
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(body, { status: 400 }),
    })
    const error = await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up(' }))

    expect(error.code).toBe('UPSTREAM_QUERY_FAILED')
    expect(error.upstreamMessage).toBe('parse error at char 3')
  })

  it.each([[422], [200]])('hides the upstream error text for HTTP %s', async (status) => {
    const body = { status: 'error', errorType: 'execution', error: 'too many samples' }
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(body, { status }),
    })
    const error = await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }))

    expect(error.code).toBe('UPSTREAM_QUERY_FAILED')
    expect(error.errorType).toBe('execution')
    expect(error.upstreamMessage).toBeUndefined()
  })

  it('collects Prometheus warnings into meta', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse({ ...vector(1), warnings: ['partial data'] }),
    })
    const result = await clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })
    expect(result.meta.warnings).toEqual(['partial data'])
  })

  it.each([[{ query: '' }], [{ query: 'x'.repeat(4_001) }], [{ timeout: '2h' }], [{ timeout: '1h30m' }]])(
    'rejects invalid arguments %o',
    async (overrides) => {
      const fetchImpl = vi.fn()
      const params = { datasourceUid: 'prom-1', query: 'up', ...overrides }
      expect((await captureError(clientWith(fetchImpl).query(params))).code).toBe('INVALID_INPUT')
    },
  )
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t query`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
const MAX_QUERY_LENGTH = 4_000
const MAX_WARNINGS = 5
const MAX_WARNING_CHARS = 200
const SERIES_HINT =
  'Narrow the result with label filters or an aggregation such as topk() or sum by ().'

  /** Runs an instant PromQL query through the Grafana data source proxy. */
  async query(params: QueryParams, signal?: AbortSignal): Promise<ApiResult> {
    const search = new URLSearchParams({ query: assertQuery(params.query) })
    if (params.time !== undefined) {
      assertText('time', params.time, 64)
      search.set('time', params.time)
    }
    if (params.timeout !== undefined) {
      assertTimeout(params.timeout, this.#config.requestTimeoutMs)
      search.set('timeout', params.timeout)
    }
    const body = await this.#proxyGet(params.datasourceUid, 'api/v1/query', search, signal)
    return this.#readPromResult(body, 200)
  }

  #readPromResult(body: JsonValue, status: number): ApiResult {
    const payload = expectObject(body)
    if (payload.status === 'error') throw createUpstreamError(status, payload, this.#config.token)
    const data = expectObject(payload.data ?? {})
    const series = Array.isArray(data.result) ? data.result : []
    const kept = series.slice(0, this.#config.maxSeries)
    const meta: JsonObject = {
      seriesReturned: kept.length,
      seriesTotal: series.length,
      truncated: series.length > kept.length,
    }
    const warnings = readWarnings(payload.warnings)
    if (warnings) meta.warnings = warnings
    if (meta.truncated) meta.hint = SERIES_HINT
    return { data: { resultType: data.resultType ?? null, result: kept }, meta }
  }
```

```ts
function assertQuery(value: string): string {
  assertText('query', value, MAX_QUERY_LENGTH)
  return value
}

function assertTimeout(value: string, requestTimeoutMs: number): void {
  const parsed = parseDurationMs('timeout', value)
  if (parsed < 1 || parsed > requestTimeoutMs) {
    throw inputError(`timeout must be between 1 ms and the configured requestTimeoutMs (${requestTimeoutMs} ms).`)
  }
}

function readWarnings(value: JsonValue | undefined): JsonValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, MAX_WARNINGS)
    .map((entry) => entry.slice(0, MAX_WARNING_CHARS))
}
```

**HTTP 400/422 的接線**：`#readResponse` 目前對非 2xx 一律丟 `createHttpError`。Prometheus 的 400/422 帶著結構化 body，必須改成：非 2xx 且 `content-type` 為 JSON 且解析後 `status === 'error'` 時，改丟 `createUpstreamError(response.status, parsed, token)`。在 `#readResponse` 的非 2xx 分支加入這段前置判斷（其餘狀態碼行為不變）：

```ts
    if (!response.ok) {
      const upstream = await readUpstreamBody(response, this.#config.maxResponseBytes)
      if (upstream) throw createUpstreamError(response.status, upstream, this.#config.token)
      throw createHttpError(response.status, safeHeader(response.headers, 'Retry-After', this.#config.token))
    }
```

```ts
async function readUpstreamBody(response: Response, maximum: number): Promise<JsonObject | undefined> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!isJsonContentType(contentType)) {
    await response.body?.cancel()
    return undefined
  }
  try {
    const parsed = JSON.parse(await readBoundedBody(response, maximum)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const body = parsed as JsonObject
    return body.status === 'error' ? body : undefined
  } catch {
    return undefined
  }
}
```

> 注意：`readUpstreamBody` 內的 `readBoundedBody` 可能自己丟 `RESPONSE_TOO_LARGE`；那個 catch 會吞掉它並退回 `createHttpError`。這是可接受的——非 2xx 且超大的 body 本來就只該回報 HTTP 狀態。

- [ ] **Step 4: 跑測試確認綠燈（含 Task 7 的 pre-flight 段）**

Run: `bun run test tests/client.test.ts`
Expected: PASS（Task 7 的 9 個 pre-flight 案例此時全部轉綠）

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add instant PromQL query with series trimming"
```

---

## Task 9: `queryRange()` — 區間 query 與點數控制

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `parseStepSeconds` / `chooseStepSeconds`、Task 7 的 `#proxyGet`、Task 8 的 `#readPromResult`
- Produces: `queryRange(params: QueryRangeParams, signal?: AbortSignal): Promise<ApiResult>`；`meta` 形狀 `{ stepApplied, stepAuto, maxPoints, seriesReturned, seriesTotal, totalPoints, truncated, warnings?, hint? }`

- [ ] **Step 1: 寫失敗測試（追加）**

```ts
function matrix(seriesCount: number, pointsPerSeries: number) {
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: Array.from({ length: seriesCount }, (_, s) => ({
        metric: { instance: `host-${s}` },
        values: Array.from({ length: pointsPerSeries }, (_, p) => [1_700_000_000 + p * 15, '1']),
      })),
    },
  }
}

const RANGE = { datasourceUid: 'prom-1', query: 'up', start: '1700000000', end: '1700003600' }

describe('queryRange', () => {
  it('derives a step from the range when none is given', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 10)),
    })
    const result = await clientWith(fetchImpl).queryRange(RANGE)

    const url = new URL(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1][0]))
    expect(url.pathname.endsWith('/api/v1/query_range')).toBe(true)
    expect(url.searchParams.get('step')).toBe('30')
    expect(result.meta).toMatchObject({ stepApplied: 30, stepAuto: true, maxPoints: 200 })
  })

  it('sends an explicit step verbatim in whole seconds', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 10)),
    })
    const result = await clientWith(fetchImpl).queryRange({ ...RANGE, step: '5m' })

    const url = new URL(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1][0]))
    expect(url.searchParams.get('step')).toBe('300')
    expect(result.meta).toMatchObject({ stepApplied: 300, stepAuto: false })
  })

  it('refuses an explicit step that would exceed max_points, before issuing any request', async () => {
    const fetchImpl = vi.fn()
    const error = await captureError(
      clientWith(fetchImpl).queryRange({ ...RANGE, step: '1s', maxPoints: 10 }),
    )

    expect(error.code).toBe('QUERY_RANGE_TOO_LARGE')
    expect(error.message).toContain('3600')
    expect(error.message).toContain('10')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('trims whole series when the total point budget is exceeded', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(100, 500)),
    })
    const result = await clientWith(fetchImpl).queryRange({ ...RANGE, maxPoints: 500 })
    const series = (result.data as { result: { values: unknown[] }[] }).result

    expect(series).toHaveLength(40)
    expect(series.every((entry) => entry.values.length === 500)).toBe(true)
    expect(result.meta).toMatchObject({ truncated: true, totalPoints: 20_000, seriesTotal: 100 })
  })

  it.each([
    [{ start: '1700003600', end: '1700000000' }],
    [{ end: 'not-a-time' }],
    [{ step: '1h30m' }],
    [{ step: '500ms' }],
    [{ maxPoints: 0 }],
    [{ maxPoints: 501 }],
    [{ start: '1600000000' }],
  ])('rejects invalid range arguments %o', async (overrides) => {
    const fetchImpl = vi.fn()
    expect((await captureError(clientWith(fetchImpl).queryRange({ ...RANGE, ...overrides }))).code).toBe(
      'INVALID_INPUT',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

> `{ start: '1600000000' }` 這一列讓區間變成約 1157 天，超過 31 天上限。

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t queryRange`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
const MAX_POINTS_PER_SERIES = 500
const DEFAULT_MAX_POINTS = 200
const MAX_TOTAL_POINTS = 20_000
const MAX_RANGE_SECONDS = 31 * 86_400

  /** Runs a range PromQL query with an enforced point budget. */
  async queryRange(params: QueryRangeParams, signal?: AbortSignal): Promise<ApiResult> {
    const maxPoints = assertMaxPoints(params.maxPoints)
    const startSeconds = assertInstant('start', params.start)
    const endSeconds = assertInstant('end', params.end)
    const rangeSeconds = assertRange(startSeconds, endSeconds)
    const step = resolveStep(params.step, rangeSeconds, maxPoints)

    const search = new URLSearchParams({
      query: assertQuery(params.query),
      start: params.start,
      end: params.end,
      step: String(step.seconds),
    })
    const body = await this.#proxyGet(params.datasourceUid, 'api/v1/query_range', search, signal)
    return finalizeRange(this.#readPromResult(body, 200), step, maxPoints)
  }
```

```ts
interface ResolvedStep {
  readonly seconds: number
  readonly auto: boolean
}

function assertMaxPoints(value = DEFAULT_MAX_POINTS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POINTS_PER_SERIES) {
    throw inputError(`maxPoints must be an integer between 1 and ${MAX_POINTS_PER_SERIES}.`)
  }
  return value
}

function assertInstant(name: string, value: string): number {
  const numeric = Number(value)
  const seconds = Number.isFinite(numeric) ? numeric : Date.parse(value) / 1_000
  if (!Number.isFinite(seconds)) {
    throw inputError(`${name} must be an RFC3339 timestamp or a Unix timestamp in seconds.`)
  }
  return seconds
}

function assertRange(startSeconds: number, endSeconds: number): number {
  const rangeSeconds = Math.ceil(endSeconds - startSeconds)
  if (rangeSeconds < 1) throw inputError('end must be later than start by at least one second.')
  if (rangeSeconds > MAX_RANGE_SECONDS) {
    throw inputError(`the range must not exceed ${MAX_RANGE_SECONDS} seconds (31 days).`)
  }
  return rangeSeconds
}

function resolveStep(step: string | undefined, rangeSeconds: number, maxPoints: number): ResolvedStep {
  if (step === undefined) return { seconds: chooseStepSeconds(rangeSeconds, maxPoints), auto: true }
  const seconds = parseStepSeconds(step)
  const points = Math.ceil(rangeSeconds / seconds)
  if (points > maxPoints) {
    const required = Math.ceil(rangeSeconds / maxPoints)
    throw new GrafanaApiError(
      `This range would return about ${points} points per series, above the limit of ${maxPoints}. Raise step to at least ${required} seconds, or shorten the range to ${maxPoints * seconds} seconds or less.`,
      { code: 'QUERY_RANGE_TOO_LARGE' },
    )
  }
  return { seconds, auto: false }
}

function finalizeRange(result: ApiResult, step: ResolvedStep, maxPoints: number): ApiResult {
  const data = result.data as { resultType: JsonValue; result: JsonValue[] }
  const kept: JsonValue[] = []
  let totalPoints = 0
  for (const entry of data.result) {
    const points = isJsonObject(entry) && Array.isArray(entry.values) ? entry.values.length : 0
    if (totalPoints + points > MAX_TOTAL_POINTS) break
    totalPoints += points
    kept.push(entry)
  }
  const truncated = result.meta.truncated === true || kept.length < data.result.length
  const meta: JsonObject = {
    ...result.meta,
    stepApplied: step.seconds,
    stepAuto: step.auto,
    maxPoints,
    seriesReturned: kept.length,
    totalPoints,
    truncated,
  }
  if (truncated) meta.hint = SERIES_HINT
  return { data: { resultType: data.resultType, result: kept }, meta }
}
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/client.test.ts`
Expected: PASS

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add range query with enforced step and point budget"
```

---

## Task 10: `alertState()` — 攤平、狀態正規化、截斷順序

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `#get` / `expectObject`、`AlertStateParams`
- Produces: `alertState(params: AlertStateParams, signal?: AbortSignal): Promise<ApiResult>`；`data` 形狀 `{ rules: [...] }`；`meta` 形狀 `{ total, page, pageSize, truncated, stateVocabulary, counts: { firing, pending, inactive, unknown }, hint? }`；exported helper `normalizeAlertState(value: string): { state: string; normalized: boolean }`

- [ ] **Step 1: 寫失敗測試（追加）**

```ts
const RULES_BODY = {
  status: 'success',
  data: {
    groups: [
      {
        name: 'cpu',
        file: 'Infra',
        rules: [
          {
            name: 'HighCPU',
            state: 'firing',
            health: 'ok',
            labels: { severity: 'critical' },
            annotations: { summary: 'CPU is high', description: 'd', runbook_url: 'r', internal: 'x' },
            lastEvaluation: '2026-08-26T00:00:00Z',
            evaluationTime: 0.01,
            duration: 300,
            alerts: Array.from({ length: 25 }, (_, i) => ({
              labels: { instance: `h-${i}` },
              state: 'Alerting',
              activeAt: '2026-08-26T00:00:00Z',
              value: 'v'.repeat(400),
            })),
          },
          { name: 'LowDisk', state: 'Normal', health: 'ok', alerts: [] },
          { name: 'Weird', state: 'Whatever', health: 'ok', alerts: [] },
        ],
      },
    ],
  },
}

describe('alertState', () => {
  it('flattens groups, normalizes states, and keeps unknown states visible by default', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl).alertState({})
    const rules = (result.data as { rules: Record<string, unknown>[] }).rules

    expect(rules.map((rule) => rule.name)).toEqual(['HighCPU', 'Weird'])
    expect(rules[0]).toMatchObject({ group: 'cpu', folder: 'Infra', state: 'firing' })
    expect(rules[1]).toMatchObject({ state: 'unknown', stateRaw: 'Whatever' })
    expect(result.meta).toMatchObject({
      stateVocabulary: 'grafana-normalized',
      counts: { firing: 1, pending: 0, inactive: 1, unknown: 1 },
    })
  })

  it('trims annotations to the three useful keys', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl).alertState({})
    const rule = (result.data as { rules: { annotations: Record<string, string> }[] }).rules[0]

    expect(Object.keys(rule.annotations).sort()).toEqual(['description', 'runbook_url', 'summary'])
  })

  it('caps instances per rule and truncates instance values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl).alertState({})
    const rule = (result.data as { rules: Record<string, unknown>[] }).rules[0]
    const instances = rule.activeInstances as { value: string; state: string }[]

    expect(instances).toHaveLength(10)
    expect(instances[0].value).toHaveLength(200)
    expect(instances[0].state).toBe('firing')
    expect(rule).toMatchObject({ instancesTruncated: true, instancesTotal: 25 })
  })

  it('omits instances when include_instances is false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl).alertState({ includeInstances: false })
    expect((result.data as { rules: Record<string, unknown>[] }).rules[0]).not.toHaveProperty('activeInstances')
  })

  it('truncates before paginating and reports the pre-truncation total', async () => {
    const many = {
      status: 'success',
      data: {
        groups: [
          {
            name: 'g',
            file: 'f',
            rules: Array.from({ length: 900 }, (_, i) => ({ name: `r-${i}`, state: 'firing', alerts: [] })),
          },
        ],
      },
    }
    const fetchImpl = vi.fn(async () => jsonResponse(many))
    const client = clientWith(fetchImpl)

    const first = await client.alertState({})
    expect(first.meta).toMatchObject({ total: 900, truncated: true })
    expect(first.meta.hint).toBeTypeOf('string')

    const beyond = await client.alertState({ page: 26 })
    expect((beyond.data as { rules: unknown[] }).rules).toEqual([])
  })

  it.each([[{ state: [] }], [{ state: ['bogus'] }], [{ maxInstancesPerRule: 51 }]])(
    'rejects invalid arguments %o',
    async (params) => {
      const fetchImpl = vi.fn()
      expect((await captureError(clientWith(fetchImpl).alertState(params))).code).toBe('INVALID_INPUT')
    },
  )
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t alertState`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
const MAX_ALERT_RULES = 500
const MAX_INSTANCES_PER_RULE = 50
const DEFAULT_INSTANCES_PER_RULE = 10
const MAX_ANNOTATION_CHARS = 500
const MAX_INSTANCE_VALUE_CHARS = 200
const ANNOTATION_KEYS = ['summary', 'description', 'runbook_url'] as const
const ALERT_STATES = ['firing', 'pending', 'inactive', 'unknown'] as const
const DEFAULT_ALERT_STATES = ['firing', 'pending', 'unknown'] as const
const STATE_ALIASES: Record<string, string> = {
  alerting: 'firing',
  firing: 'firing',
  pending: 'pending',
  inactive: 'inactive',
  normal: 'inactive',
  ok: 'inactive',
}
const ALERT_HINT = 'Narrow the result with rule_contains or folder_contains.'

/** Maps a Grafana or Prometheus alert state onto the Prometheus vocabulary. */
export function normalizeAlertState(value: string): { state: string; normalized: boolean } {
  const lower = value.trim().toLowerCase()
  const mapped = STATE_ALIASES[lower]
  if (!mapped) return { state: 'unknown', normalized: true }
  return { state: mapped, normalized: mapped !== value }
}
```

方法本體拆成四個小函式以滿足複雜度上限：`flattenAlertRules(body)` → `filterAlertRules(rules, params)` → `paginate(list, page, pageSize)` → 組 `meta`。

```ts
  /** Returns the current state of Grafana unified alerting rules. */
  async alertState(params: AlertStateParams, signal?: AbortSignal): Promise<ApiResult> {
    const states = assertStates(params.state)
    const page = assertPage(params.page)
    const pageSize = assertPageSize(params.pageSize)
    const maxInstances = assertInstances(params.maxInstancesPerRule)

    const body = expectObject(await this.#get('api/prometheus/grafana/api/v1/rules', new URLSearchParams(), signal))
    const flattened = flattenAlertRules(body, params.includeInstances !== false, maxInstances)
    const counts = countStates(flattened.rules)
    const matched = flattened.rules.filter((rule) => matchesAlertRule(rule, states, params))
    const capped = matched.slice(0, MAX_ALERT_RULES)
    const start = (page - 1) * pageSize

    const meta: JsonObject = {
      total: matched.length,
      page,
      pageSize,
      truncated: matched.length > capped.length,
      stateVocabulary: flattened.normalized ? 'grafana-normalized' : 'prometheus',
      counts,
    }
    if (meta.truncated) meta.hint = ALERT_HINT
    return { data: { rules: capped.slice(start, start + pageSize) }, meta }
  }
```

`flattenAlertRules` 的職責：走訪 `data.groups[]` → `rules[]`，每條產出白名單物件、正規化 `state`、裁剪 `annotations`（只留 `ANNOTATION_KEYS`、各截 `MAX_ANNOTATION_CHARS`）、裁剪 `alerts[]`（正規化每個 instance 的 `state`、`value` 截 `MAX_INSTANCE_VALUE_CHARS`、超過 `maxInstances` 時加 `instancesTruncated` 與 `instancesTotal`），並回報是否發生過狀態轉換。`assertStates` 驗證每個值都在 `ALERT_STATES` 內、長度 1–4，未提供時回 `DEFAULT_ALERT_STATES`。`assertInstances` 上限 `MAX_INSTANCES_PER_RULE`、預設 `DEFAULT_INSTANCES_PER_RULE`。

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/client.test.ts`
Expected: PASS

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add alert state flattening with state normalization"
```

---

## Task 11: `listAlertRules()` — 規則定義與查詢摘要

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `#get` / `expectArray`、Task 10 的 `MAX_ALERT_RULES` 與 annotation 裁剪 helper、`ListAlertRulesParams`
- Produces: `listAlertRules(params: ListAlertRulesParams, signal?: AbortSignal): Promise<ApiResult>`；`data` 形狀 `{ rules: [...] }`；`meta` 形狀 `{ total, page, pageSize, truncated, hint? }`

- [ ] **Step 1: 寫失敗測試（追加）**

```ts
const PROVISIONED = [
  {
    uid: 'rule-1',
    title: 'HighCPU',
    folderUID: 'folder-1',
    ruleGroup: 'cpu',
    condition: 'C',
    for: '5m',
    isPaused: false,
    noDataState: 'NoData',
    execErrState: 'Error',
    labels: { severity: 'critical' },
    annotations: { summary: 's', description: 'd', runbook_url: 'r', internal: 'x' },
    data: [
      { refId: 'A', datasourceUid: 'prom-1', model: { expr: 'rate(cpu[5m])', extra: 'noise' } },
      { refId: 'C', datasourceUid: '__expr__', model: { type: 'threshold' } },
    ],
  },
]

describe('listAlertRules', () => {
  it('drops the query model unless include_query is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROVISIONED))
    const result = await clientWith(fetchImpl).listAlertRules({})
    const rule = (result.data as { rules: Record<string, unknown>[] }).rules[0]

    expect(rule).not.toHaveProperty('data')
    expect(JSON.stringify(result)).not.toContain('noise')
    expect(Object.keys(rule.annotations as object).sort()).toEqual(['description', 'runbook_url', 'summary'])
  })

  it('summarizes each query node when include_query is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROVISIONED))
    const result = await clientWith(fetchImpl).listAlertRules({ includeQuery: true })
    const rule = (result.data as { rules: { data: Record<string, unknown>[] }[] }).rules[0]

    expect(rule.data).toEqual([
      { refId: 'A', datasourceUid: 'prom-1', expr: 'rate(cpu[5m])' },
      { refId: 'C', datasourceUid: '__expr__', type: 'threshold' },
    ])
  })

  it('filters by folder, group, and title before paginating', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROVISIONED))
    const client = clientWith(fetchImpl)

    await expect(client.listAlertRules({ folderUid: 'nope' })).resolves.toMatchObject({ meta: { total: 0 } })
    await expect(client.listAlertRules({ titleContains: 'highcpu' })).resolves.toMatchObject({ meta: { total: 1 } })
    await expect(client.listAlertRules({ ruleGroup: 'cpu' })).resolves.toMatchObject({ meta: { total: 1 } })
  })

  it('accepts the top-level array shape returned by the provisioning API', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await expect(clientWith(fetchImpl).listAlertRules({})).resolves.toMatchObject({ meta: { total: 0 } })
  })

  it('reports the pre-truncation total and refuses to page past the cap', async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ uid: `u-${i}`, title: `r-${i}`, ruleGroup: 'g' }))
    const fetchImpl = vi.fn(async () => jsonResponse(many))
    const client = clientWith(fetchImpl)

    expect((await client.listAlertRules({})).meta).toMatchObject({ total: 900, truncated: true })
    expect(((await client.listAlertRules({ page: 26 })).data as { rules: unknown[] }).rules).toEqual([])
  })

  it('maps a 404 to ALERTING_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    expect((await captureError(clientWith(fetchImpl).listAlertRules({}))).code).toBe('ALERTING_UNAVAILABLE')
  })
})
```

> `alertState()` 的 404 也必須映射成 `ALERTING_UNAVAILABLE`——請在 Task 10 的測試檔補上同形的一則案例，並在兩個方法共用同一個 `translateAlertingError()` helper。

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/client.test.ts -t listAlertRules`
Expected: FAIL

- [ ] **Step 3: 實作**

```ts
const MAX_EXPR_CHARS = 1_000

  /** Lists provisioned Grafana alert rule definitions. */
  async listAlertRules(params: ListAlertRulesParams, signal?: AbortSignal): Promise<ApiResult> {
    const page = assertPage(params.page)
    const pageSize = assertPageSize(params.pageSize)
    const raw = expectArray(await this.#getAlerting('api/v1/provisioning/alert-rules', signal))
    const rules = raw.filter(isJsonObject).map((rule) => toPublicAlertRule(rule, params.includeQuery === true))
    const matched = rules.filter((rule) => matchesProvisionedRule(rule, params))
    const capped = matched.slice(0, MAX_ALERT_RULES)
    const start = (page - 1) * pageSize

    const meta: JsonObject = {
      total: matched.length,
      page,
      pageSize,
      truncated: matched.length > capped.length,
    }
    if (meta.truncated) meta.hint = 'Narrow the result with folder_uid, rule_group, or title_contains.'
    return { data: { rules: capped.slice(start, start + pageSize) }, meta }
  }

  async #getAlerting(endpoint: string, signal?: AbortSignal): Promise<JsonValue> {
    try {
      return await this.#get(endpoint, new URLSearchParams(), signal)
    } catch (error: unknown) {
      throw translateAlertingError(error)
    }
  }
```

```ts
function translateAlertingError(error: unknown): unknown {
  if (error instanceof GrafanaApiError && error.code === 'NOT_FOUND') {
    return new GrafanaApiError(
      'Grafana unified alerting is unavailable on this instance. This plugin requires Grafana 9.0 or newer with unified alerting enabled.',
      { code: 'ALERTING_UNAVAILABLE', status: error.status },
    )
  }
  return error
}

function summarizeQueryNode(node: JsonObject): JsonObject {
  const model = isJsonObject(node.model) ? node.model : {}
  const summary: JsonObject = {
    refId: readString(node.refId) ?? '',
    datasourceUid: readString(node.datasourceUid) ?? '',
  }
  const expr = readString(model.expr)
  if (expr) summary.expr = expr.slice(0, MAX_EXPR_CHARS)
  const type = readString(model.type)
  if (!expr && type) summary.type = type
  return summary
}
```

`toPublicAlertRule` 只保留 `uid` / `title` / `folderUID` / `ruleGroup` / `condition` / `for` / `isPaused` / `noDataState` / `execErrState` / `labels` / `annotations`（沿用 Task 10 的 annotation 裁剪 helper），`includeQuery` 為真時再加 `data: node.map(summarizeQueryNode)`。`matchesProvisionedRule` 對 `folderUid` / `ruleGroup` 做精確比對，對 `titleContains` 做大小寫不敏感的子字串比對。同時把 `alertState()` 的 `#get` 換成 `#getAlerting`。

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/client.test.ts`
Expected: PASS（`client.test.ts` 至此涵蓋 spec §9 的全部 client 案例）

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add provisioned alert rule listing with query summaries"
```

---

## Task 12: `locales.ts` — 四語 tool metadata 與 config i18n

**Files:**
- Create: `src/locales.ts`, `tests/locales.test.ts`

**Interfaces:**
- Consumes: `Locale` / `LOCALES`（`config.ts`）
- Produces:
  - `interface GrafanaMessages`（見下方完整鍵集）
  - `grafanaMessages(locale: Locale): GrafanaMessages`
  - `CONFIG_I18N`（7 語系鍵：`en` / `en-US` / `zh` / `zh-CN` / `zh-TW` / `ja` / `ja-JP`）

`GrafanaMessages` 的完整鍵集（四語必須完全一致）：

- 六個工具描述：`healthDescription`、`datasourcesDescription`、`queryDescription`、`queryRangeDescription`、`alertStateDescription`、`alertRulesDescription`
- 六個 `presentCall` 標題：`healthTitle`、`datasourcesTitle`、`queryTitle`、`queryRangeTitle`、`alertStateTitle`、`alertRulesTitle`
- 21 個參數說明：`datasourceUid`、`query`、`time`、`timeout`、`start`、`end`、`step`、`maxPoints`、`type`、`nameContains`、`state`、`folderContains`、`ruleContains`、`includeInstances`、`maxInstancesPerRule`、`folderUid`、`ruleGroup`、`titleContains`、`includeQuery`、`page`、`pageSize`

- [ ] **Step 1: 寫失敗測試 `tests/locales.test.ts`**

```ts
import { describe, expect, it } from 'vitest'

import { LOCALES } from '../src/config.js'
import { CONFIG_I18N, grafanaMessages } from '../src/locales.js'

const CONFIG_KEYS = [
  '$description',
  'baseUrl',
  'locale',
  'maxResponseBytes',
  'maxSeries',
  'requestTimeoutMs',
  'token',
]

describe('tool metadata locales', () => {
  it('exposes identical key sets across every locale', () => {
    const reference = Object.keys(grafanaMessages('en')).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(grafanaMessages(locale)).sort()).toEqual(reference)
    }
  })

  it('never returns an empty string', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(grafanaMessages(locale))) {
        expect(value, `${locale}.${key}`).toBeTypeOf('string')
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('mentions the step and point limits in every query_range description', () => {
    for (const locale of LOCALES) {
      const description = grafanaMessages(locale).queryRangeDescription
      expect(description).toMatch(/step/i)
      expect(description).toMatch(/200|point|點|点|ポイント/)
    }
  })

  it('mentions the default alert states in every alert_state description', () => {
    for (const locale of LOCALES) {
      const description = grafanaMessages(locale).alertStateDescription
      expect(description).toMatch(/firing/)
      expect(description).toMatch(/pending/)
      expect(description).toMatch(/unknown/)
    }
  })
})

describe('CONFIG_I18N', () => {
  it('covers all seven Schemastery locale keys with identical field sets', () => {
    expect(Object.keys(CONFIG_I18N).sort()).toEqual(
      ['en', 'en-US', 'ja', 'ja-JP', 'zh', 'zh-CN', 'zh-TW'].sort(),
    )
    for (const [locale, messages] of Object.entries(CONFIG_I18N)) {
      expect(Object.keys(messages).sort(), locale).toEqual(CONFIG_KEYS)
    }
  })

  it('names the environment variables in every locale', () => {
    for (const messages of Object.values(CONFIG_I18N)) {
      expect(messages.baseUrl).toContain('GRAFANA_URL')
      expect(messages.token).toContain('GRAFANA_TOKEN')
    }
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/locales.test.ts`
Expected: FAIL —「Cannot find module '../src/locales.js'」

- [ ] **Step 3: 實作 `src/locales.ts`**

結構照 `~/side/ankey/dsh-forge/src/i18n.ts`：先宣告 `interface GrafanaMessages`，再寫四個 `const ENGLISH/TRADITIONAL_CHINESE/SIMPLIFIED_CHINESE/JAPANESE: GrafanaMessages`，最後 `const MESSAGES: Record<Locale, GrafanaMessages>` 與 `grafanaMessages()`。`CONFIG_I18N` 照 `~/side/ankey/dsh-sonarqube/src/locales.ts`，欄位換成本專案的六個。

英文版的關鍵字串（其餘三語照此語意翻譯，數字與工具名不變）：

```ts
const ENGLISH: GrafanaMessages = {
  healthDescription: 'Check that the configured Grafana instance is reachable and the token works.',
  healthTitle: 'Check Grafana health',
  datasourcesDescription:
    'List Grafana data sources and their uid, type, and access mode. Run this first to get the uid needed by the query tools.',
  datasourcesTitle: 'List Grafana data sources',
  queryDescription:
    'Run an instant PromQL query against a Prometheus data source through the Grafana proxy. Returns at most 100 series by default.',
  queryTitle: 'Run an instant PromQL query',
  queryRangeDescription:
    'Run a range PromQL query through the Grafana proxy. When step is omitted it is chosen automatically so each series stays within max_points (default 200); an explicit step that would exceed that limit is rejected.',
  queryRangeTitle: 'Run a range PromQL query',
  alertStateDescription:
    'List the current state of Grafana unified alerting rules. Returns firing, pending, and unknown rules by default.',
  alertStateTitle: 'Read Grafana alert state',
  alertRulesDescription:
    'List Grafana unified alerting rule definitions. Query models are omitted unless include_query is set.',
  alertRulesTitle: 'List Grafana alert rules',
  datasourceUid: 'Data source uid from grafana_list_datasources',
  query: 'PromQL expression, 1-4000 characters',
  time: 'Evaluation instant as RFC3339 or Unix seconds; defaults to now',
  timeout: 'Prometheus-side query timeout such as 10s; must not exceed the configured request timeout',
  start: 'Range start as RFC3339 or Unix seconds',
  end: 'Range end as RFC3339 or Unix seconds; must be later than start',
  step:
    'Resolution such as 15s, 5m, or whole seconds. Omit to let the plugin pick one; the ms unit is not accepted',
  maxPoints: 'Maximum points per series, 1-500; defaults to 200',
  type: 'Filter data sources by type, for example prometheus',
  nameContains: 'Filter data sources whose name contains this text',
  state: 'Alert states to include: firing, pending, inactive, or unknown',
  folderContains: 'Filter alert rules whose folder name contains this text',
  ruleContains: 'Filter alert rules whose name contains this text',
  includeInstances: 'Include the firing alert instances for each rule; defaults to true',
  maxInstancesPerRule: 'Maximum alert instances per rule, 1-50; defaults to 10',
  folderUid: 'Only return alert rules in this folder uid',
  ruleGroup: 'Only return alert rules in this rule group',
  titleContains: 'Filter alert rules whose title contains this text',
  includeQuery: 'Include a summary of each rule query; defaults to false',
  page: '1-based page number; defaults to 1',
  pageSize: 'Results per page, 1-100; defaults to 20',
}
```

`CONFIG_I18N` 的英文版：

```ts
const ENGLISH_CONFIG = {
  $description: 'Read-only Grafana metrics and alerting integration settings.',
  baseUrl: 'Grafana base URL. Falls back to GRAFANA_URL.',
  token: 'Grafana service account token. Prefer the GRAFANA_TOKEN environment variable.',
  locale: 'Language used for tool descriptions.',
  requestTimeoutMs: 'Request timeout in milliseconds.',
  maxResponseBytes: 'Maximum successful response body size in bytes.',
  maxSeries: 'Maximum number of series returned by a single query.',
} as const
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/locales.test.ts`
Expected: PASS

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add four-language tool metadata and config descriptions"
```

---

## Task 13: `tools.ts` — 六個 DSH 工具註冊

**Files:**
- Create: `src/tools.ts`, `tests/tools.test.ts`

**Interfaces:**
- Consumes: `GrafanaClient`（`client.ts`）、`grafanaMessages`（`locales.ts`）、`Locale`（`config.ts`）
- Produces: `registerGrafanaTools(ctx: Context, client: GrafanaClient, locale: Locale): void`

- [ ] **Step 1: 寫失敗測試 `tests/tools.test.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import type { GrafanaClient } from '../src/client.js'
import { grafanaMessages } from '../src/locales.js'
import { registerGrafanaTools } from '../src/tools.js'

const TOOL_NAMES = [
  'grafana_alert_state',
  'grafana_health',
  'grafana_list_alert_rules',
  'grafana_list_datasources',
  'grafana_query',
  'grafana_query_range',
]

function collect(locale: Parameters<typeof grafanaMessages>[0] = 'en') {
  const register = vi.fn()
  const client = {
    health: vi.fn(async () => ({ data: {}, meta: {} })),
    listDatasources: vi.fn(async () => ({ data: {}, meta: {} })),
    query: vi.fn(async () => ({ data: {}, meta: {} })),
    queryRange: vi.fn(async () => ({ data: {}, meta: {} })),
    alertState: vi.fn(async () => ({ data: {}, meta: {} })),
    listAlertRules: vi.fn(async () => ({ data: {}, meta: {} })),
  }
  registerGrafanaTools({ tools: { register } } as unknown as Context, client as unknown as GrafanaClient, locale)
  const tools = register.mock.calls.map(([tool]) => tool as ToolDefinition)
  return { tools, client, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

describe('registerGrafanaTools', () => {
  it('registers exactly the six read-only tools', () => {
    const { tools } = collect()
    expect(tools).toHaveLength(6)
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)
  })

  it('marks every tool as concurrency safe', () => {
    for (const tool of collect().tools) expect(tool.isConcurrencySafe?.()).toBe(true)
  })

  it('renders results as a single JSON text block', () => {
    const tool = collect().byName.get('grafana_health')
    const value = { data: { database: 'ok' }, meta: {} }
    const rendered = tool?.output?.render?.({}, value)
    expect(rendered).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(JSON.parse((rendered as { text: string }[])[0].text)).toEqual(value)
  })

  it('maps snake_case arguments onto camelCase client parameters', async () => {
    const { byName, client } = collect()
    await byName.get('grafana_query_range')?.execute(
      {
        datasource_uid: 'prom-1',
        query: 'up',
        start: '1700000000',
        end: '1700003600',
        step: '1m',
        max_points: 50,
      },
      { signal: undefined } as never,
    )

    expect(client.queryRange).toHaveBeenCalledWith(
      {
        datasourceUid: 'prom-1',
        query: 'up',
        start: '1700000000',
        end: '1700003600',
        step: '1m',
        maxPoints: 50,
      },
      undefined,
    )
  })

  it('switches descriptions with the locale but keeps tool names in English', () => {
    const zh = collect('zh-TW')
    expect(zh.byName.get('grafana_query_range')?.description).toBe(
      grafanaMessages('zh-TW').queryRangeDescription,
    )
    expect(zh.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)
  })

  it('describes the enforced limits in every locale', () => {
    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ja'] as const) {
      const description = collect(locale).byName.get('grafana_query_range')?.description ?? ''
      expect(description).toMatch(/step/i)
    }
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/tools.test.ts`
Expected: FAIL —「Cannot find module '../src/tools.js'」

- [ ] **Step 3: 實作 `src/tools.ts`**

形狀照 `~/side/ankey/dsh-sonarqube/src/tools.ts`：一個 `registerGrafanaTools()` 呼叫六個 `registerXxx()` 小函式，每個小函式只做一次 `ctx.tools.register(defineTool({...}))`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { GrafanaClient } from './client.js'
import type { Locale } from './config.js'
import { type GrafanaMessages, grafanaMessages } from './locales.js'
import type { JsonValue } from './types.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: { type: 'json', required: true },
    meta: { type: 'json', required: true },
  },
} as const

const ALERT_STATES = ['firing', 'pending', 'inactive', 'unknown'] as const

/** Registers all read-only Grafana tools on a DSH tools service. */
export function registerGrafanaTools(ctx: Context, client: GrafanaClient, locale: Locale): void {
  const messages = grafanaMessages(locale)
  registerHealth(ctx, client, messages)
  registerListDatasources(ctx, client, messages)
  registerQuery(ctx, client, messages)
  registerQueryRange(ctx, client, messages)
  registerAlertState(ctx, client, messages)
  registerListAlertRules(ctx, client, messages)
}

function registerQueryRange(ctx: Context, client: GrafanaClient, messages: GrafanaMessages): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_query_range',
      description: messages.queryRangeDescription,
      parameters: {
        datasource_uid: { type: 'string', required: true, description: messages.datasourceUid },
        query: { type: 'string', required: true, description: messages.query },
        start: { type: 'string', required: true, description: messages.start },
        end: { type: 'string', required: true, description: messages.end },
        step: { type: 'string', description: messages.step },
        max_points: { type: 'integer', description: messages.maxPoints },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (args, exec) =>
        client.queryRange(
          {
            datasourceUid: args.datasource_uid,
            query: args.query,
            start: args.start,
            end: args.end,
            step: args.step,
            maxPoints: args.max_points,
          },
          exec.signal,
        ),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.queryRangeTitle, kind: 'read' }),
    }),
  )
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
```

其餘五個 `registerXxx()` 依同一形狀撰寫，參數對照：

| 工具 | 參數（snake_case → client camelCase） |
| --- | --- |
| `grafana_health` | 無參數 |
| `grafana_list_datasources` | `type` → `type`、`name_contains` → `nameContains`、`page` → `page`、`page_size` → `pageSize` |
| `grafana_query` | `datasource_uid` → `datasourceUid`、`query`、`time`、`timeout` |
| `grafana_alert_state` | `state`（`array` of `string` with `enum: ALERT_STATES`）、`folder_contains` → `folderContains`、`rule_contains` → `ruleContains`、`include_instances` → `includeInstances`（`boolean`）、`max_instances_per_rule` → `maxInstancesPerRule`（`integer`）、`page`、`page_size` |
| `grafana_list_alert_rules` | `folder_uid` → `folderUid`、`rule_group` → `ruleGroup`、`title_contains` → `titleContains`、`include_query` → `includeQuery`（`boolean`）、`page`、`page_size` |

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test tests/tools.test.ts`
Expected: PASS

- [ ] **Step 5: 全套驗證並 commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: register the six read-only Grafana tools"
```

---

## Task 14: `index.ts` — Cordis 插件入口

**Files:**
- Create: `src/index.ts`, `tests/plugin.test.ts`

**Interfaces:**
- Consumes: 全部前面的模組
- Produces: `name = 'dsh-grafana-query'`、`inject = ['tools']`、`Config`（Schemastery）、`apply(ctx: Context, config: Config): void`，以及 `GrafanaClient` / `createGrafanaClient` / `GrafanaApiError` / 型別的 re-export

- [ ] **Step 1: 寫失敗測試 `tests/plugin.test.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { apply, Config, inject, name } from '../src/index.js'

describe('DSH plugin entry', () => {
  it('exports the required identity and tools injection', () => {
    expect(name).toBe('dsh-grafana-query')
    expect(inject).toEqual(['tools'])
    expect(Config).toBeDefined()
  })

  it('exposes localized configuration descriptions', () => {
    expect(Config.meta.description).toMatchObject({
      en: expect.stringContaining('Grafana'),
      'zh-TW': expect.any(String),
      'zh-CN': expect.any(String),
      'ja-JP': expect.any(String),
    })
    expect(Config.dict?.token?.meta.role).toBe('secret')
    expect(Config.dict?.token?.meta.description).toMatchObject({
      en: expect.stringContaining('GRAFANA_TOKEN'),
      'zh-TW': expect.stringContaining('GRAFANA_TOKEN'),
    })
  })

  it('declares the documented numeric bounds', () => {
    expect(Config.dict?.requestTimeoutMs?.meta).toMatchObject({ default: 30_000, min: 1, max: 300_000, step: 1 })
    expect(Config.dict?.maxResponseBytes?.meta).toMatchObject({
      default: 5 * 1024 * 1024,
      min: 1,
      max: 50 * 1024 * 1024,
      step: 1,
    })
    expect(Config.dict?.maxSeries?.meta).toMatchObject({ default: 100, min: 1, max: 1_000, step: 1 })
    expect(Config.dict?.locale?.meta.default).toBe('en')
  })

  it('registers six tools when applied', () => {
    const register = vi.fn()
    apply({ tools: { register } } as unknown as Context, {
      baseUrl: 'https://grafana.example.com',
      token: 'glsa_token',
    })
    expect(register).toHaveBeenCalledTimes(6)
  })

  it('fails fast on an invalid base URL', () => {
    const register = vi.fn()
    expect(() =>
      apply({ tools: { register } } as unknown as Context, { baseUrl: 'ftp://x', token: 't' }),
    ).toThrow(/Invalid Grafana configuration/)
  })
})
```

- [ ] **Step 2: 跑測試確認紅燈**

Run: `bun run test tests/plugin.test.ts`
Expected: FAIL —「Cannot find module '../src/index.js'」

- [ ] **Step 3: 實作 `src/index.ts`**

```ts
/**
 * dsh-grafana-query — read-only Grafana metrics and alert tools for DeepSeek Harness.
 * @module dsh-grafana-query
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { createGrafanaClient } from './client.js'
import type { GrafanaConfig } from './config.js'
import {
  DEFAULT_LOCALE,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SERIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOCALES,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_SERIES_LIMIT,
  resolveConfig,
} from './config.js'
import { CONFIG_I18N } from './locales.js'
import { registerGrafanaTools } from './tools.js'

export { createGrafanaClient, GrafanaClient } from './client.js'
export type { GrafanaConfig, Locale, ResolvedGrafanaConfig } from './config.js'
export { createHttpError, createUpstreamError, GrafanaApiError } from './errors.js'
export type * from './types.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-grafana-query'

/** DSH services required by this plugin. */
export const inject = ['tools']

/** Plugin configuration supplied through Cordis. */
export type Config = GrafanaConfig

/** Schemastery configuration exposed by the plugin. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string(),
  token: Schema.string().role('secret'),
  locale: Schema.union(LOCALES.map((locale) => Schema.const(locale))).default(DEFAULT_LOCALE),
  requestTimeoutMs: Schema.number()
    .step(1)
    .min(1)
    .max(MAX_REQUEST_TIMEOUT_MS)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  maxResponseBytes: Schema.number()
    .step(1)
    .min(1)
    .max(MAX_RESPONSE_BYTES)
    .default(DEFAULT_MAX_RESPONSE_BYTES),
  maxSeries: Schema.number().step(1).min(1).max(MAX_SERIES_LIMIT).default(DEFAULT_MAX_SERIES),
}).i18n(CONFIG_I18N)

/** Creates the client and registers all read-only tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  registerGrafanaTools(ctx, createGrafanaClient(config), resolved.locale)
}
```

- [ ] **Step 4: 跑測試確認綠燈**

Run: `bun run test`
Expected: PASS（六個測試檔全綠）

- [ ] **Step 5: 檢查 coverage 門檻**

Run: `bun run test --coverage`
Expected: branches / functions / lines / statements 皆 ≥ 80。若未達標，補測 spec §9 中尚未覆蓋的分支（通常是 `client.ts` 的錯誤路徑），**不要調低門檻**。

- [ ] **Step 6: Commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add the Cordis plugin entry point"
```

---

## Task 15: 四語 README

**Files:**
- Create: `README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`

**Interfaces:**
- Consumes: 完成的工具與設定
- Produces: 四份互相連結的說明文件（`package.json` 的 `files` 已列入）

四份都必須有相同的章節結構（照 `~/side/ankey/dsh-sonarqube/README.md`）：

1. 標題 + 語言切換連結列
2. 一段定位說明，**必須包含一句**與 npm 上既有 `dsh-grafana`（dashboard 編輯器，寫入型）的區隔
3. `## Tools` 表：六個工具各一列
4. `## Requirements`：DSH、Node.js `^22.19.0 || >=24.0.0`、**Grafana 9.0 以上**
5. `## Configuration` 表：六個欄位（`baseUrl` / `token` / `locale` / `requestTimeoutMs` / `maxResponseBytes` / `maxSeries`）含預設與上下界；環境變數 `GRAFANA_URL` / `GRAFANA_TOKEN`
6. `## Permissions` 表：spec §2.5 的五列最小權限
7. `## Grafana Cloud`：baseUrl 用 `https://<stack>.grafana.net/`、用 service account token、**`glc_` 開頭的 Access Policy token 不適用**
8. `## Install`：`bun add dsh-grafana-query`（或 npm/pnpm），以及 `cordis.patch.yml` 的說明
9. `## Examples`：`grafana_list_datasources` → `grafana_query` → `grafana_query_range` 的三步流程
10. `## Internationalization`：`locale` 可設 `en` / `zh-TW` / `zh-CN` / `ja`；工具名固定英文
11. `## Security and error behavior`：唯讀、錯誤不帶 token 或 body、**唯一例外是 HTTP 400 時透出 Prometheus 的 `error` 欄位，上限 200 字元且已 redaction**
12. `## Development`：四個驗證指令
13. `## License`：MIT

- [ ] **Step 1: 寫 `README.md`（英文）**，涵蓋上列 13 節
- [ ] **Step 2: 依英文版翻出 `README.zh-TW.md` / `README.zh-CN.md` / `README.ja.md`**，四份的表格列數與數字必須完全一致
- [ ] **Step 3: 驗證四份文件的連結與一致性**

```bash
grep -c '^## ' README.md README.zh-TW.md README.zh-CN.md README.ja.md
grep -l 'dsh-grafana-query' README*.md | wc -l
grep -L 'glc_' README*.md
```

Expected：四份的 `## ` 章節數相同（13）；四份都含套件名；最後一個指令沒有輸出（代表四份都提到 `glc_` 的限制）。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add four-language README"
```

---

## Task 16: CI 與 release workflow

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `package.json` 的四個 script
- Produces: push/PR 的 CI；`v*` tag 觸發的發版流程

- [ ] **Step 1: 寫 `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test --coverage
      - run: bun run build
```

- [ ] **Step 2: 寫 `.github/workflows/release.yml`**

以 `~/side/ankey/dsh-sonarqube/.github/workflows/release.yml` 為底，只改套件名。**`$GITHUB_ENV` 那一行不可省略**——跨 step 的 shell 變數不會保留，`dsh-forge` v0.3.2 就是因此掛掉。

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test --coverage
      - run: bun run build
      - name: Verify tag and build tarball
        run: |
          PACKAGE_VERSION="$(node --print "require('./package.json').version")"
          test "$GITHUB_REF_NAME" = "v${PACKAGE_VERSION}"
          bun pm pack
          PACKAGE_TARBALL="dsh-grafana-query-${PACKAGE_VERSION}.tgz"
          tar --list --gzip --file "$PACKAGE_TARBALL"
          cp "$PACKAGE_TARBALL" dsh-grafana-query.tgz
          sha256sum "$PACKAGE_TARBALL" dsh-grafana-query.tgz >SHA256SUMS
          echo "PACKAGE_TARBALL=$PACKAGE_TARBALL" >>"$GITHUB_ENV"
      - name: Publish GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
        run: >-
          gh release create "$GITHUB_REF_NAME" "$PACKAGE_TARBALL" dsh-grafana-query.tgz SHA256SUMS
          --verify-tag --generate-notes
```

- [ ] **Step 3: 本機驗證封裝內容**

```bash
bun run build
bun pm pack
tar --list --gzip --file dsh-grafana-query-0.1.0.tgz
rm -f dsh-grafana-query-0.1.0.tgz
```

Expected：tarball 內含 `lib/`（7 個 `.js` + `.d.ts`）、`cordis.patch.yml`、四份 README、`LICENSE`、`package.json`；**不含** `src/`、`tests/`、`docs/`。

- [ ] **Step 4: 確認 registry 必要欄位**

```bash
node --print "JSON.stringify(require('./package.json').dsh)"
node --print "require('./package.json').peerDependencies['@deepseek-ai/dsh-tools']"
```

Expected：第一個輸出 `{"bundle":{"patch":"./cordis.patch.yml"}}`；第二個輸出 `^0.1.0-rc.8 || ^0.1.1-rc.2`。

- [ ] **Step 5: Commit 並推送**

```bash
git add -A
git commit -m "ci: add verification and release workflows"
git push
```

---

## Task 17: 上線前 live 驗證

**Files:**
- Create: `scripts/smoke-dsh.sh`, `docs/superpowers/specs/2026-08-26-dsh-grafana-verification.md`

**Interfaces:**
- Consumes: 建置好的 `lib/`
- Produces: 一份記錄 spec §11 全部 12 項（L1–L12）實測結果的 verification note

**這一步不是可選的。** spec §11 列的 12 項假設全部是「Grafana 實際行為」，單測全部 mock fetch 所以驗證不到。發 `v0.1.0` tag 之前必須跑完。

- [ ] **Step 1: 寫 `scripts/smoke-dsh.sh`**

腳本讀 `GRAFANA_URL` / `GRAFANA_TOKEN` 環境變數，用 `node --input-type=module` 直接 import `lib/index.js` 的 `createGrafanaClient()`，依序呼叫六個方法並印出結果摘要（不印 token）。形狀參考 `~/side/ankey/dsh-forge/scripts/smoke-dsh.sh`。

- [ ] **Step 2: 對自架 Grafana 跑一輪**

```bash
GRAFANA_URL='https://<self-hosted>/grafana/' GRAFANA_TOKEN='glsa_...' bun run smoke:dsh
```

逐項記錄 L1 / L2 / L3 / L4 / L5 / L6 / L8 / L9 / L11 / L12 的實際行為。

- [ ] **Step 3: 對 Grafana Cloud 跑一輪**

```bash
GRAFANA_URL='https://<stack>.grafana.net/' GRAFANA_TOKEN='glsa_...' bun run smoke:dsh
```

逐項記錄 L1 / L7 / L10 / L11 的實際行為。

- [ ] **Step 4: 寫 verification note 並回填 spec**

把 L1–L12 的結論寫進 `docs/superpowers/specs/2026-08-26-dsh-grafana-verification.md`。**若 L3 實測回 422 而非 400**，依 spec §11 的回退條款把 §6.2 的透出條件放寬到「400 或 422」，同步改 `errors.ts`、`tests/errors.test.ts` 與 spec 三處。**若 L5 出現第三種狀態詞彙**，補進 `STATE_ALIASES`。**若 L12 顯示 Grafana 不允許「只有 query 沒有 read」的權限組合**，把 `#datasourceMeta` 的 403 分支改為直接拋 `PERMISSION_DENIED` 並刪掉對應測試。

- [ ] **Step 5: Commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "test: add live smoke script and verification notes"
git push
```

---

## Self-Review

**1. Spec coverage**

| spec 章節 | 對應 Task |
| --- | --- |
| §2.1 uid proxy 路徑 | Task 7（`#proxyGet`）、Task 8 的 URL 斷言 |
| §2.3 metadata 前置檢查、降級表、404 判別 | Task 7 |
| §2.4 unified alerting 兩端點、狀態正規化 | Task 10、Task 11 |
| §2.5 Bearer 認證、權限表 | Task 4（header）、Task 15（README 權限表） |
| §2.6 Cloud 差異、sub-path baseUrl | Task 2（`normalizeBaseUrl`）、Task 4（URL 斷言）、Task 15 |
| §3.1–3.6 六個工具 | Task 4、5、8、9、10、11（client）+ Task 13（工具註冊） |
| §3.4.1 duration 文法 | Task 6 |
| §3.4.2 step 與點數上限 | Task 6、Task 9 |
| §4 三道防線與常數放置 | Task 2（config.ts 常數）、Task 4（bounded body）、Task 8/9（裁剪） |
| §5 config schema、`cordis.patch.yml` | Task 1、Task 2、Task 14 |
| §6.1 錯誤碼 | Task 2（型別）、Task 3（映射）、Task 7/11（Grafana 專屬碼） |
| §6.2 400-only 透出 | Task 3（實作 + 測試）、Task 8（接線） |
| §6.3 頂層物件或陣列 | Task 4（`parseJsonValue` / `expectObject` / `expectArray`） |
| §7 檔案結構與職責 | 本文件的「檔案結構」表 + Task 1–14 |
| §8 專案慣例 10 條 | Task 1（1、2、6、8、9、10）、Task 13（7）、Task 15（4）、Task 16（3、5） |
| §9 測試策略 | Task 2–14 的紅燈清單 |
| §10 非目標 | 無 Task——非目標本來就不實作；Task 13 只註冊六個工具即為執行證據 |
| §11 live 驗證清單 | Task 17 |
| §12 決策紀錄 | 全域約束章節已把影響實作的部分抄成硬性條款 |

無缺口。

**2. Placeholder scan**：已檢查，無 TBD / TODO /「適當地處理錯誤」/「為上述撰寫測試」。唯一以描述取代完整程式碼之處是 Task 10 Step 3 的 `flattenAlertRules`——它是純資料轉換，輸入輸出形狀已由該 Task 的六個測試完整鎖定，且該 Step 逐條列出了它要做的每一件事（白名單、狀態正規化、annotation 三鍵裁剪、instance 上限與 value 截斷）。Task 5 與 Task 6 的兩處期望值已改為正確且可直接照抄的形式。

**3. Type consistency**：`ApiResult` 全程為 `{ data: JsonValue; meta: JsonObject }`；`GrafanaClient` 的六個方法名（`health` / `listDatasources` / `query` / `queryRange` / `alertState` / `listAlertRules`）在 Task 4–14 與 Task 13 的 stub client 中一致；`registerGrafanaTools(ctx, client, locale)` 的三參數形狀在 §7、Task 13、Task 14 一致；`grafanaMessages(locale)` 在 Task 12、13 一致；`parseDurationMs(name, value)` 兩參數形狀在 Task 6 定義、Task 8（`assertTimeout`）與 Task 6（`parseStepSeconds`）使用一致；`inputError` / `configError` 在 Task 2 定義、Task 5–11 使用。
