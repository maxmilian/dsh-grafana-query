import type { Locale } from './config.js'

/** Localized model-facing tool metadata. */
export interface GrafanaMessages {
  readonly healthDescription: string
  readonly healthTitle: string
  readonly datasourcesDescription: string
  readonly datasourcesTitle: string
  readonly queryDescription: string
  readonly queryTitle: string
  readonly queryRangeDescription: string
  readonly queryRangeTitle: string
  readonly alertStateDescription: string
  readonly alertStateTitle: string
  readonly alertRulesDescription: string
  readonly alertRulesTitle: string
  readonly datasourceUid: string
  readonly query: string
  readonly time: string
  readonly timeout: string
  readonly start: string
  readonly end: string
  readonly step: string
  readonly maxPoints: string
  readonly type: string
  readonly nameContains: string
  readonly state: string
  readonly folderContains: string
  readonly ruleContains: string
  readonly includeInstances: string
  readonly maxInstancesPerRule: string
  readonly folderUid: string
  readonly ruleGroup: string
  readonly titleContains: string
  readonly includeQuery: string
  readonly page: string
  readonly pageSize: string
}

const ENGLISH: GrafanaMessages = {
  healthDescription:
    'Check that the configured Grafana instance is reachable and report its version. This endpoint does not require authentication, so it does not validate the configured credentials.',
  healthTitle: 'Check Grafana health',
  datasourcesDescription:
    'List Grafana data sources with their uid, type, and access mode. Run this first to get the uid needed by the query tools.',
  datasourcesTitle: 'List Grafana data sources',
  queryDescription:
    'Run an instant PromQL query against a Prometheus data source through the Grafana proxy. Returns at most 100 series by default.',
  queryTitle: 'Run an instant PromQL query',
  queryRangeDescription:
    'Run a range PromQL query through the Grafana proxy. When step is omitted it is chosen automatically so each series stays within max_points (default 200); an explicit step that would exceed that limit is rejected. The range must not exceed 31 days. If the response would exceed 20000 points in total, trailing series are dropped whole and meta.truncated says so.',
  queryRangeTitle: 'Run a range PromQL query',
  alertStateDescription:
    'List the current state of Grafana unified alerting rules. Returns firing, pending, and unknown rules by default. At most 500 matching rules are reachable; the rest cannot be paged to, so narrow the result with folder_contains or rule_contains.',
  alertStateTitle: 'Read Grafana alert state',
  alertRulesDescription:
    'List Grafana unified alerting rule definitions. Query models are omitted unless include_query is set. At most 500 matching rules are reachable; the rest cannot be paged to, so narrow the result with folder_uid, rule_group, or title_contains.',
  alertRulesTitle: 'List Grafana alert rules',
  datasourceUid: 'Data source uid from grafana_list_datasources',
  query: 'PromQL expression, 1-4000 characters',
  time: 'Evaluation instant as RFC3339 or Unix seconds; defaults to now',
  timeout:
    'Prometheus-side query timeout such as 10s; must not exceed the configured request timeout',
  start: 'Range start as RFC3339 or Unix seconds',
  end: 'Range end as RFC3339 or Unix seconds; must be later than start',
  step: 'Resolution such as 15s, 5m, or whole seconds. Omit to let the plugin pick one; the ms unit is not accepted',
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

const TRADITIONAL_CHINESE: GrafanaMessages = {
  healthDescription:
    '檢查設定的 Grafana 是否可連線並回報版本。此端點不需認證，因此不會驗證設定的憑證。',
  healthTitle: '檢查 Grafana 健康狀態',
  datasourcesDescription:
    '列出 Grafana datasource 的 uid、type 與 access 模式。查詢工具需要的 uid 由此取得，請先呼叫此工具。',
  datasourcesTitle: '列出 Grafana datasource',
  queryDescription:
    '透過 Grafana proxy 對 Prometheus datasource 執行 instant PromQL 查詢。預設最多回傳 100 條 series。',
  queryTitle: '執行 instant PromQL 查詢',
  queryRangeDescription:
    '透過 Grafana proxy 執行區間 PromQL 查詢。省略 step 時會自動選一個值，讓每條 series 的點數不超過 max_points（預設 200）；明確指定的 step 若會超過上限則直接拒絕。區間最長 31 天；回應總點數若會超過 20000，後面的 series 會被整條捨棄，並以 meta.truncated 標示。',
  queryRangeTitle: '執行區間 PromQL 查詢',
  alertStateDescription:
    '列出 Grafana unified alerting 規則的當前狀態。預設回傳 firing、pending 與 unknown 的規則。最多只能取得前 500 條符合的規則，其餘無法靠翻頁取得，請用 folder_contains 或 rule_contains 縮小範圍。',
  alertStateTitle: '讀取 Grafana 告警狀態',
  alertRulesDescription:
    '列出 Grafana unified alerting 的規則定義。未設定 include_query 時不會回傳查詢模型。最多只能取得前 500 條符合的規則，其餘無法靠翻頁取得，請用 folder_uid、rule_group 或 title_contains 縮小範圍。',
  alertRulesTitle: '列出 Grafana 告警規則',
  datasourceUid: '來自 grafana_list_datasources 的 datasource uid',
  query: 'PromQL 運算式，1-4000 字元',
  time: '評估時間點，RFC3339 或 Unix 秒；省略代表現在',
  timeout: 'Prometheus 端查詢逾時，例如 10s；不可超過設定的 request timeout',
  start: '區間起點，RFC3339 或 Unix 秒',
  end: '區間終點，RFC3339 或 Unix 秒；必須晚於 start',
  step: '解析度，例如 15s、5m 或純秒數。省略則由插件自動決定；不接受 ms 單位',
  maxPoints: '每條 series 的點數上限，1-500；預設 200',
  type: '依 datasource 類型篩選，例如 prometheus',
  nameContains: '篩選名稱包含此文字的 datasource',
  state: '要納入的告警狀態：firing、pending、inactive 或 unknown',
  folderContains: '篩選 folder 名稱包含此文字的告警規則',
  ruleContains: '篩選名稱包含此文字的告警規則',
  includeInstances: '是否附上每條規則的告警 instance；預設為 true',
  maxInstancesPerRule: '每條規則的告警 instance 上限，1-50；預設 10',
  folderUid: '只回傳此 folder uid 底下的告警規則',
  ruleGroup: '只回傳此 rule group 底下的告警規則',
  titleContains: '篩選標題包含此文字的告警規則',
  includeQuery: '是否附上每條規則的查詢摘要；預設為 false',
  page: '1 起算的頁碼；預設 1',
  pageSize: '每頁筆數，1-100；預設 20',
}

const SIMPLIFIED_CHINESE: GrafanaMessages = {
  healthDescription:
    '检查配置的 Grafana 是否可连接并返回版本。此端点不需要认证，因此不会验证配置的凭证。',
  healthTitle: '检查 Grafana 健康状态',
  datasourcesDescription:
    '列出 Grafana datasource 的 uid、type 与 access 模式。查询工具需要的 uid 由此获取，请先调用此工具。',
  datasourcesTitle: '列出 Grafana datasource',
  queryDescription:
    '通过 Grafana proxy 对 Prometheus datasource 执行 instant PromQL 查询。默认最多返回 100 条 series。',
  queryTitle: '执行 instant PromQL 查询',
  queryRangeDescription:
    '通过 Grafana proxy 执行区间 PromQL 查询。省略 step 时会自动选择一个值，使每条 series 的点数不超过 max_points（默认 200）；显式指定的 step 若会超过上限则直接拒绝。区间最长 31 天；响应总点数若会超过 20000，后面的 series 会被整条丢弃，并以 meta.truncated 标示。',
  queryRangeTitle: '执行区间 PromQL 查询',
  alertStateDescription:
    '列出 Grafana unified alerting 规则的当前状态。默认返回 firing、pending 与 unknown 的规则。最多只能获取前 500 条匹配的规则，其余无法通过翻页获取，请用 folder_contains 或 rule_contains 缩小范围。',
  alertStateTitle: '读取 Grafana 告警状态',
  alertRulesDescription:
    '列出 Grafana unified alerting 的规则定义。未设置 include_query 时不会返回查询模型。最多只能获取前 500 条匹配的规则，其余无法通过翻页获取，请用 folder_uid、rule_group 或 title_contains 缩小范围。',
  alertRulesTitle: '列出 Grafana 告警规则',
  datasourceUid: '来自 grafana_list_datasources 的 datasource uid',
  query: 'PromQL 表达式，1-4000 字符',
  time: '评估时间点，RFC3339 或 Unix 秒；省略表示现在',
  timeout: 'Prometheus 端查询超时，例如 10s；不可超过配置的 request timeout',
  start: '区间起点，RFC3339 或 Unix 秒',
  end: '区间终点，RFC3339 或 Unix 秒；必须晚于 start',
  step: '分辨率，例如 15s、5m 或纯秒数。省略则由插件自动决定；不接受 ms 单位',
  maxPoints: '每条 series 的点数上限，1-500；默认 200',
  type: '按 datasource 类型筛选，例如 prometheus',
  nameContains: '筛选名称包含此文本的 datasource',
  state: '要包含的告警状态：firing、pending、inactive 或 unknown',
  folderContains: '筛选 folder 名称包含此文本的告警规则',
  ruleContains: '筛选名称包含此文本的告警规则',
  includeInstances: '是否附上每条规则的告警 instance；默认为 true',
  maxInstancesPerRule: '每条规则的告警 instance 上限，1-50；默认 10',
  folderUid: '只返回此 folder uid 下的告警规则',
  ruleGroup: '只返回此 rule group 下的告警规则',
  titleContains: '筛选标题包含此文本的告警规则',
  includeQuery: '是否附上每条规则的查询摘要；默认为 false',
  page: '从 1 开始的页码；默认 1',
  pageSize: '每页条数，1-100；默认 20',
}

const JAPANESE: GrafanaMessages = {
  healthDescription:
    '設定された Grafana に接続できるかを確認し、バージョンを返します。このエンドポイントは認証を必要としないため、設定した認証情報の検証は行いません。',
  healthTitle: 'Grafana のヘルスを確認',
  datasourcesDescription:
    'Grafana のデータソースの uid、type、access モードを一覧します。クエリツールに必要な uid はここで取得するため、最初に実行してください。',
  datasourcesTitle: 'Grafana データソースを一覧',
  queryDescription:
    'Grafana のプロキシ経由で Prometheus データソースに instant PromQL クエリを実行します。既定では最大 100 series を返します。',
  queryTitle: 'instant PromQL クエリを実行',
  queryRangeDescription:
    'Grafana のプロキシ経由で範囲 PromQL クエリを実行します。step を省略すると各 series が max_points（既定 200）を超えないよう自動的に選ばれ、上限を超える step を明示した場合は拒否されます。範囲は最長 31 日です。応答の合計ポイント数が 20000 を超える場合、後方の series は丸ごと破棄され、meta.truncated で示されます。',
  queryRangeTitle: '範囲 PromQL クエリを実行',
  alertStateDescription:
    'Grafana unified alerting のルールの現在の状態を一覧します。既定では firing、pending、unknown のルールを返します。取得できるのは一致したルールの先頭 500 件までで、それ以降はページ送りでも取得できません。folder_contains か rule_contains で絞り込んでください。',
  alertStateTitle: 'Grafana のアラート状態を読む',
  alertRulesDescription:
    'Grafana unified alerting のルール定義を一覧します。include_query を指定しない限りクエリモデルは省略されます。取得できるのは一致したルールの先頭 500 件までで、それ以降はページ送りでも取得できません。folder_uid、rule_group、title_contains で絞り込んでください。',
  alertRulesTitle: 'Grafana のアラートルールを一覧',
  datasourceUid: 'grafana_list_datasources で取得したデータソース uid',
  query: 'PromQL 式、1〜4000 文字',
  time: '評価時点。RFC3339 または Unix 秒。省略時は現在',
  timeout: 'Prometheus 側のクエリタイムアウト（例: 10s）。設定した request timeout を超えないこと',
  start: '範囲の開始。RFC3339 または Unix 秒',
  end: '範囲の終了。RFC3339 または Unix 秒。start より後であること',
  step: '解像度（例: 15s、5m、または秒数）。省略するとプラグインが選択します。ms 単位は使えません',
  maxPoints: 'series ごとの最大ポイント数、1〜500。既定は 200',
  type: 'データソースを type で絞り込む（例: prometheus）',
  nameContains: '名前にこの文字列を含むデータソースを絞り込む',
  state: '含めるアラート状態: firing、pending、inactive、unknown',
  folderContains: 'フォルダ名にこの文字列を含むアラートルールを絞り込む',
  ruleContains: '名前にこの文字列を含むアラートルールを絞り込む',
  includeInstances: '各ルールのアラートインスタンスを含める。既定は true',
  maxInstancesPerRule: 'ルールごとのアラートインスタンス上限、1〜50。既定は 10',
  folderUid: 'この folder uid のアラートルールのみ返す',
  ruleGroup: 'この rule group のアラートルールのみ返す',
  titleContains: 'タイトルにこの文字列を含むアラートルールを絞り込む',
  includeQuery: '各ルールのクエリ概要を含める。既定は false',
  page: '1 から始まるページ番号。既定は 1',
  pageSize: '1 ページあたりの件数、1〜100。既定は 20',
}

const MESSAGES: Record<Locale, GrafanaMessages> = {
  en: ENGLISH,
  'zh-TW': TRADITIONAL_CHINESE,
  'zh-CN': SIMPLIFIED_CHINESE,
  ja: JAPANESE,
}

/** Returns the tool metadata for a configured locale. */
export function grafanaMessages(locale: Locale): GrafanaMessages {
  return MESSAGES[locale]
}

interface ConfigLocaleMessages {
  readonly $description: string
  readonly baseUrl: string
  readonly token: string
  readonly locale: string
  readonly requestTimeoutMs: string
  readonly maxResponseBytes: string
  readonly maxSeries: string
}

const ENGLISH_CONFIG = {
  $description: 'Read-only Grafana metrics and alerting integration settings.',
  baseUrl: 'Grafana base URL. Falls back to GRAFANA_URL.',
  token: 'Grafana service account token. Prefer the GRAFANA_TOKEN environment variable.',
  locale: 'Language used for tool descriptions.',
  requestTimeoutMs: 'Request timeout in milliseconds.',
  maxResponseBytes: 'Maximum successful response body size in bytes.',
  maxSeries: 'Maximum number of series returned by a single query.',
} as const satisfies ConfigLocaleMessages

const TRADITIONAL_CHINESE_CONFIG = {
  $description: 'Grafana 指標與告警的唯讀整合設定。',
  baseUrl: 'Grafana 基底網址；未設定時讀取 GRAFANA_URL。',
  token: 'Grafana service account token；建議使用 GRAFANA_TOKEN 環境變數。',
  locale: '工具描述使用的語言。',
  requestTimeoutMs: '請求逾時時間（毫秒）。',
  maxResponseBytes: '成功回應內容的大小上限（位元組）。',
  maxSeries: '單次查詢回傳的 series 數上限。',
} as const satisfies ConfigLocaleMessages

const SIMPLIFIED_CHINESE_CONFIG = {
  $description: 'Grafana 指标与告警的只读集成设置。',
  baseUrl: 'Grafana 基础 URL；未设置时读取 GRAFANA_URL。',
  token: 'Grafana service account token；建议使用 GRAFANA_TOKEN 环境变量。',
  locale: '工具描述使用的语言。',
  requestTimeoutMs: '请求超时时间（毫秒）。',
  maxResponseBytes: '成功响应内容的大小上限（字节）。',
  maxSeries: '单次查询返回的 series 数上限。',
} as const satisfies ConfigLocaleMessages

const JAPANESE_CONFIG = {
  $description: 'Grafana のメトリクスとアラートの読み取り専用連携設定。',
  baseUrl: 'Grafana のベース URL。未設定の場合は GRAFANA_URL を使用します。',
  token: 'Grafana service account token。GRAFANA_TOKEN 環境変数の使用を推奨します。',
  locale: 'ツールの説明に使用する言語。',
  requestTimeoutMs: 'リクエストのタイムアウト時間（ミリ秒）。',
  maxResponseBytes: '成功レスポンス本文の最大サイズ（バイト）。',
  maxSeries: '1 回のクエリで返す series 数の上限。',
} as const satisfies ConfigLocaleMessages

/** Localized descriptions consumed by the Schemastery configuration schema. */
export const CONFIG_I18N = {
  en: ENGLISH_CONFIG,
  'en-US': ENGLISH_CONFIG,
  zh: SIMPLIFIED_CHINESE_CONFIG,
  'zh-CN': SIMPLIFIED_CHINESE_CONFIG,
  'zh-TW': TRADITIONAL_CHINESE_CONFIG,
  ja: JAPANESE_CONFIG,
  'ja-JP': JAPANESE_CONFIG,
} as const satisfies Record<string, ConfigLocaleMessages>
