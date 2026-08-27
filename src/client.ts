import type { GrafanaConfig, ResolvedGrafanaConfig } from './config.js'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  resolveConfig,
  validateResolvedConfig,
} from './config.js'
import type { GrafanaErrorCode } from './errors.js'
import {
  createHttpError,
  createUpstreamError,
  GrafanaApiError,
  inputError,
  safeHeader,
} from './errors.js'
import type {
  AlertStateParams,
  ApiResult,
  DatasourceMeta,
  JsonArray,
  JsonObject,
  JsonValue,
  ListAlertRulesParams,
  ListDatasourcesParams,
  QueryParams,
  QueryRangeParams,
} from './types.js'

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
  readonly #datasourceCache = new Map<string, DatasourceMeta>()

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

  /** Lists data sources with safe fields only, filtered and paginated client-side. */
  async listDatasources(params: ListDatasourcesParams, signal?: AbortSignal): Promise<ApiResult> {
    const page = assertPage(params.page)
    const pageSize = assertPageSize(params.pageSize)
    if (params.nameContains !== undefined) assertText('nameContains', params.nameContains, 200)
    if (params.type !== undefined) assertText('type', params.type, 100)

    const raw = expectArray(await this.#get('api/datasources', new URLSearchParams(), signal))
    const all = raw.filter(isJsonObject).map(readDatasource)
    for (const entry of all) {
      this.#datasourceCache.set(entry.uid, { type: entry.type, access: entry.access })
    }

    const matched = all.filter((entry) => matchesDatasource(entry, params))
    const start = (page - 1) * pageSize
    return {
      data: { datasources: matched.slice(start, start + pageSize).map(toPublicDatasource) },
      meta: { total: matched.length, page, pageSize },
    }
  }

  /** Runs an instant PromQL query through the Grafana data source proxy. */
  async query(params: QueryParams, signal?: AbortSignal): Promise<ApiResult> {
    const search = new URLSearchParams({ query: assertQuery(params.query) })
    if (params.time !== undefined) {
      parseInstantSeconds('time', params.time)
      search.set('time', params.time)
    }
    if (params.timeout !== undefined) {
      assertTimeout(params.timeout, this.#config.requestTimeoutMs)
      search.set('timeout', params.timeout)
    }
    const body = await this.#proxyGet(params.datasourceUid, 'api/v1/query', search, signal)
    return this.#readPromResult(body, 200)
  }

  /** Runs a range PromQL query with an enforced point budget. */
  async queryRange(params: QueryRangeParams, signal?: AbortSignal): Promise<ApiResult> {
    const maxPoints = assertMaxPoints(params.maxPoints)
    const startSeconds = parseInstantSeconds('start', params.start)
    const endSeconds = parseInstantSeconds('end', params.end)
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

  /** Returns the current state of Grafana unified alerting rules. */
  async alertState(params: AlertStateParams, signal?: AbortSignal): Promise<ApiResult> {
    const states = assertStates(params.state)
    const page = assertPage(params.page)
    const pageSize = assertPageSize(params.pageSize)
    const maxInstances = assertInstances(params.maxInstancesPerRule)

    const body = expectObject(
      await this.#getAlerting('api/prometheus/grafana/api/v1/rules', signal),
    )
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

  /** Lists provisioned Grafana alert rule definitions. */
  async listAlertRules(params: ListAlertRulesParams, signal?: AbortSignal): Promise<ApiResult> {
    const page = assertPage(params.page)
    const pageSize = assertPageSize(params.pageSize)
    const raw = expectArray(await this.#getAlerting('api/v1/provisioning/alert-rules', signal))
    const rules = raw
      .filter(isJsonObject)
      .map((rule) => toPublicAlertRule(rule, params.includeQuery === true))
    const matched = rules.filter((rule) => matchesProvisionedRule(rule, params))
    const capped = matched.slice(0, MAX_ALERT_RULES)
    const start = (page - 1) * pageSize

    const meta: JsonObject = {
      total: matched.length,
      page,
      pageSize,
      truncated: matched.length > capped.length,
    }
    if (meta.truncated) meta.hint = PROVISIONED_HINT
    return { data: { rules: capped.slice(start, start + pageSize) }, meta }
  }

  async #getAlerting(endpoint: string, signal?: AbortSignal): Promise<JsonValue> {
    try {
      return await this.#get(endpoint, new URLSearchParams(), signal)
    } catch (error: unknown) {
      throw translateAlertingError(error)
    }
  }

  async #datasourceMeta(uid: string, signal?: AbortSignal): Promise<DatasourceMeta | undefined> {
    const cached = this.#datasourceCache.get(uid)
    if (cached) return cached
    try {
      const body = expectObject(
        await this.#get(`api/datasources/uid/${uid}`, new URLSearchParams(), signal),
      )
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
      return await this.#get(`api/datasources/proxy/uid/${uid}/${path}`, query, signal, true)
    } catch (error: unknown) {
      throw translateProxyError(error, uid, meta)
    }
  }

  async #get(
    endpoint: string,
    query: URLSearchParams,
    signal?: AbortSignal,
    upstreamErrors = false,
  ): Promise<JsonValue> {
    const url = new URL(endpoint, this.#config.baseUrl)
    url.search = query.toString()
    const context = createRequestContext(signal, this.#config.requestTimeoutMs)
    try {
      const response = await this.#fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#config.token}` },
        method: 'GET',
        signal: context.controller.signal,
      })
      return await this.#readResponse(response, upstreamErrors)
    } catch (error: unknown) {
      throw normalizeRequestError(error, signal, context, this.#config.requestTimeoutMs)
    } finally {
      context.dispose()
    }
  }

  async #readResponse(response: Response, upstreamErrors: boolean): Promise<JsonValue> {
    if (!response.ok) {
      if (upstreamErrors && UPSTREAM_ERROR_STATUSES.has(response.status)) {
        const upstream = await readUpstreamBody(response, this.#config.maxResponseBytes)
        if (upstream) throw createUpstreamError(response.status, upstream, this.#config.token)
      } else {
        await response.body?.cancel()
      }
      throw createHttpError(
        response.status,
        safeHeader(response.headers, 'Retry-After', this.#config.token),
      )
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
  return new GrafanaApiError(
    `Grafana response exceeded the configured maximum of ${maximum} bytes.`,
    { code: 'RESPONSE_TOO_LARGE' },
  )
}

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
  if (
    params.nameContains &&
    !entry.name.toLowerCase().includes(params.nameContains.toLowerCase())
  ) {
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertText(name: string, value: string, maximum: number): void {
  if (!value.trim() || value.length > maximum) {
    throw inputError(`${name} must contain 1-${maximum} characters.`)
  }
}

function assertPage(value = 1): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw inputError('page must be a positive integer.')
  return value
}

function assertPageSize(value = DEFAULT_PAGE_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw inputError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`)
  }
  return value
}

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

/**
 * Number of points a Prometheus range query returns. Prometheus evaluates both
 * endpoints, so a range of `rangeSeconds` at `stepSeconds` yields one extra point.
 */
export function countRangePoints(rangeSeconds: number, stepSeconds: number): number {
  return Math.floor(rangeSeconds / stepSeconds) + 1
}

/** Smallest step, in seconds, that keeps an inclusive range within the point budget. */
export function requiredStepSeconds(rangeSeconds: number, maxPoints: number): number {
  return Math.ceil((rangeSeconds + 1) / maxPoints)
}

/** Picks the smallest ladder step that keeps a range within the point budget. */
export function chooseStepSeconds(rangeSeconds: number, maxPoints: number): number {
  const required = requiredStepSeconds(rangeSeconds, maxPoints)
  return STEP_LADDER_SECONDS.find((candidate) => candidate >= required) ?? required
}

/**
 * Statuses where a Prometheus `status: "error"` body is authoritative. Every other
 * status keeps its HTTP classification, so 401/403/404/405/429/5xx stay diagnosable.
 */
const UPSTREAM_ERROR_STATUSES = new Set([400, 422])

const UID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
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

function translateProxyError(
  error: unknown,
  uid: string,
  meta: DatasourceMeta | undefined,
): unknown {
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

const MAX_QUERY_LENGTH = 4_000
const MAX_WARNINGS = 5
const MAX_WARNING_CHARS = 200
const SERIES_HINT =
  'Narrow the result with label filters or an aggregation such as topk() or sum by ().'

function assertQuery(value: string): string {
  assertText('query', value, MAX_QUERY_LENGTH)
  return value
}

function assertTimeout(value: string, requestTimeoutMs: number): void {
  const parsed = parseDurationMs('timeout', value)
  if (parsed < 1 || parsed > requestTimeoutMs) {
    throw inputError(
      `timeout must be between 1 ms and the configured requestTimeoutMs (${requestTimeoutMs} ms).`,
    )
  }
}

function readWarnings(value: JsonValue | undefined): JsonValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, MAX_WARNINGS)
    .map((entry) => entry.slice(0, MAX_WARNING_CHARS))
}

async function readUpstreamBody(
  response: Response,
  maximum: number,
): Promise<JsonObject | undefined> {
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

const MAX_POINTS_PER_SERIES = 500
const DEFAULT_MAX_POINTS = 200
const MAX_TOTAL_POINTS = 20_000
const MAX_RANGE_SECONDS = 31 * 86_400

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

const UNIX_SECONDS_PATTERN = /^-?\d+(?:\.\d+)?$/
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/

/**
 * Parses a timestamp into Unix seconds, accepting only the two forms the tool
 * metadata promises: a decimal Unix timestamp in seconds, or a complete RFC3339
 * date-time. Anything else (a bare date, `1e3`, `0x10`, relative expressions) is
 * rejected here rather than forwarded to Grafana.
 */
export function parseInstantSeconds(name: string, value: string): number {
  if (UNIX_SECONDS_PATTERN.test(value)) return Number(value)
  if (RFC3339_PATTERN.test(value)) {
    const milliseconds = Date.parse(value)
    if (Number.isFinite(milliseconds)) return milliseconds / 1_000
  }
  throw inputError(
    `${name} must be an RFC3339 date-time such as 2026-01-01T00:00:00Z, or a Unix timestamp in seconds.`,
  )
}

function assertRange(startSeconds: number, endSeconds: number): number {
  const rangeSeconds = Math.ceil(endSeconds - startSeconds)
  if (rangeSeconds < 1) throw inputError('end must be later than start by at least one second.')
  if (rangeSeconds > MAX_RANGE_SECONDS) {
    throw inputError(`the range must not exceed ${MAX_RANGE_SECONDS} seconds (31 days).`)
  }
  return rangeSeconds
}

function resolveStep(
  step: string | undefined,
  rangeSeconds: number,
  maxPoints: number,
): ResolvedStep {
  if (step === undefined) return { seconds: chooseStepSeconds(rangeSeconds, maxPoints), auto: true }
  const seconds = parseStepSeconds(step)
  const points = countRangePoints(rangeSeconds, seconds)
  if (points > maxPoints) {
    const required = requiredStepSeconds(rangeSeconds, maxPoints)
    throw new GrafanaApiError(
      `This range would return about ${points} points per series, above the limit of ${maxPoints}. Raise step to at least ${required} seconds, or shorten the range to ${maxPoints * seconds - 1} seconds or less.`,
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

const MAX_ALERT_RULES = 500
const MAX_INSTANCES_PER_RULE = 50
const DEFAULT_INSTANCES_PER_RULE = 10
const MAX_ANNOTATION_CHARS = 500
const MAX_INSTANCE_VALUE_CHARS = 200
const ANNOTATION_KEYS = ['summary', 'description', 'runbook_url'] as const
const ALERT_STATES = ['firing', 'pending', 'inactive', 'unknown'] as const
const DEFAULT_ALERT_STATES: readonly string[] = ['firing', 'pending', 'unknown']
const STATE_ALIASES: Record<string, string> = {
  alerting: 'firing',
  firing: 'firing',
  pending: 'pending',
  inactive: 'inactive',
  normal: 'inactive',
  ok: 'inactive',
}
const ALERT_HINT = 'Narrow the result with rule_contains or folder_contains.'

interface FlattenedRules {
  readonly rules: JsonObject[]
  readonly normalized: boolean
}

/** Maps a Grafana or Prometheus alert state onto the Prometheus vocabulary. */
export function normalizeAlertState(value: string): { state: string; normalized: boolean } {
  const lower = value.trim().toLowerCase()
  const mapped = STATE_ALIASES[lower]
  if (!mapped) return { state: 'unknown', normalized: true }
  return { state: mapped, normalized: mapped !== value }
}

function translateAlertingError(error: unknown): unknown {
  if (error instanceof GrafanaApiError && error.code === 'NOT_FOUND') {
    return new GrafanaApiError(
      'Grafana unified alerting is unavailable on this instance. This plugin requires Grafana 9.0 or newer with unified alerting enabled.',
      { code: 'ALERTING_UNAVAILABLE', status: error.status },
    )
  }
  return error
}

function assertStates(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_ALERT_STATES
  if (value.length < 1 || value.length > ALERT_STATES.length) {
    throw inputError(`state must contain 1-${ALERT_STATES.length} values.`)
  }
  for (const entry of value) {
    if (!ALERT_STATES.includes(entry as (typeof ALERT_STATES)[number])) {
      throw inputError(`state values must be one of ${ALERT_STATES.join(', ')}.`)
    }
  }
  return value
}

function assertInstances(value = DEFAULT_INSTANCES_PER_RULE): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INSTANCES_PER_RULE) {
    throw inputError(
      `maxInstancesPerRule must be an integer between 1 and ${MAX_INSTANCES_PER_RULE}.`,
    )
  }
  return value
}

function trimAnnotations(value: JsonValue | undefined): JsonObject {
  if (!value || !isJsonObject(value)) return {}
  const result: JsonObject = {}
  for (const key of ANNOTATION_KEYS) {
    const entry = readString(value[key])
    if (entry) result[key] = entry.slice(0, MAX_ANNOTATION_CHARS)
  }
  return result
}

function readInstances(
  value: JsonValue | undefined,
  maxInstances: number,
): { kept: JsonObject[]; total: number } {
  const all = Array.isArray(value) ? value.filter(isJsonObject) : []
  const kept = all.slice(0, maxInstances).map((entry) => {
    const raw = readString(entry.state) ?? ''
    return {
      labels: entry.labels ?? {},
      state: normalizeAlertState(raw).state,
      activeAt: entry.activeAt ?? null,
      value: (readString(entry.value) ?? '').slice(0, MAX_INSTANCE_VALUE_CHARS),
    }
  })
  return { kept, total: all.length }
}

function toFlatRule(
  rule: JsonObject,
  group: JsonObject,
  includeInstances: boolean,
  maxInstances: number,
): { rule: JsonObject; normalized: boolean } {
  const raw = readString(rule.state) ?? ''
  const state = normalizeAlertState(raw)
  const flat = baseFlatRule(rule, group, state.state)
  if (state.state === 'unknown' && raw) flat.stateRaw = raw
  if (includeInstances) attachInstances(flat, rule.alerts, maxInstances)
  return { rule: flat, normalized: state.normalized }
}

function baseFlatRule(rule: JsonObject, group: JsonObject, state: string): JsonObject {
  return {
    group: readString(group.name) ?? '',
    folder: readString(group.file) ?? '',
    name: readString(rule.name) ?? '',
    state,
    health: readString(rule.health) ?? '',
    labels: rule.labels ?? {},
    annotations: trimAnnotations(rule.annotations),
    lastEvaluation: rule.lastEvaluation ?? null,
    evaluationTime: rule.evaluationTime ?? null,
    duration: rule.duration ?? null,
  }
}

function attachInstances(
  flat: JsonObject,
  alerts: JsonValue | undefined,
  maxInstances: number,
): void {
  const instances = readInstances(alerts, maxInstances)
  flat.activeInstances = instances.kept
  if (instances.total > instances.kept.length) {
    flat.instancesTruncated = true
    flat.instancesTotal = instances.total
  }
}

function flattenAlertRules(
  body: JsonObject,
  includeInstances: boolean,
  maxInstances: number,
): FlattenedRules {
  const data = isJsonObject(body.data) ? body.data : {}
  const groups = Array.isArray(data.groups) ? data.groups.filter(isJsonObject) : []
  const rules: JsonObject[] = []
  let normalized = false
  for (const group of groups) {
    const groupRules = Array.isArray(group.rules) ? group.rules.filter(isJsonObject) : []
    for (const rule of groupRules) {
      const flat = toFlatRule(rule, group, includeInstances, maxInstances)
      if (flat.normalized) normalized = true
      rules.push(flat.rule)
    }
  }
  return { rules, normalized }
}

function countStates(rules: readonly JsonObject[]): JsonObject {
  const counts: Record<string, number> = { firing: 0, pending: 0, inactive: 0, unknown: 0 }
  for (const rule of rules) {
    const state = readString(rule.state) ?? 'unknown'
    counts[state] = (counts[state] ?? 0) + 1
  }
  return counts
}

function matchesAlertRule(
  rule: JsonObject,
  states: readonly string[],
  params: AlertStateParams,
): boolean {
  if (!states.includes(readString(rule.state) ?? '')) return false
  const folder = readString(rule.folder) ?? ''
  const name = readString(rule.name) ?? ''
  if (
    params.folderContains &&
    !folder.toLowerCase().includes(params.folderContains.toLowerCase())
  ) {
    return false
  }
  if (params.ruleContains && !name.toLowerCase().includes(params.ruleContains.toLowerCase())) {
    return false
  }
  return true
}

const MAX_EXPR_CHARS = 1_000
const PROVISIONED_HINT = 'Narrow the result with folder_uid, rule_group, or title_contains.'

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

const PROVISIONED_STRING_KEYS = [
  'uid',
  'title',
  'folderUID',
  'ruleGroup',
  'condition',
  'noDataState',
  'execErrState',
] as const

function toPublicAlertRule(rule: JsonObject, includeQuery: boolean): JsonObject {
  const result: JsonObject = {
    for: rule.for ?? null,
    isPaused: rule.isPaused === true,
    labels: rule.labels ?? {},
    annotations: trimAnnotations(rule.annotations),
  }
  for (const key of PROVISIONED_STRING_KEYS) result[key] = readString(rule[key]) ?? ''
  if (includeQuery) {
    const nodes = Array.isArray(rule.data) ? rule.data.filter(isJsonObject) : []
    result.data = nodes.map(summarizeQueryNode)
  }
  return result
}

function matchesProvisionedRule(rule: JsonObject, params: ListAlertRulesParams): boolean {
  if (params.folderUid && readString(rule.folderUID) !== params.folderUid) return false
  if (params.ruleGroup && readString(rule.ruleGroup) !== params.ruleGroup) return false
  const title = readString(rule.title) ?? ''
  if (params.titleContains && !title.toLowerCase().includes(params.titleContains.toLowerCase())) {
    return false
  }
  return true
}
