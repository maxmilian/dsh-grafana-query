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
