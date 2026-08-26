import type { GrafanaConfig, ResolvedGrafanaConfig } from './config.js'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  resolveConfig,
  validateResolvedConfig,
} from './config.js'
import { createHttpError, GrafanaApiError, inputError, safeHeader } from './errors.js'
import type {
  ApiResult,
  DatasourceMeta,
  JsonArray,
  JsonObject,
  JsonValue,
  ListDatasourcesParams,
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

function isJsonObject(value: JsonValue): value is JsonObject {
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

/** Picks the smallest ladder step that keeps a range under the point budget. */
export function chooseStepSeconds(rangeSeconds: number, maxPoints: number): number {
  const required = Math.ceil(rangeSeconds / maxPoints)
  return STEP_LADDER_SECONDS.find((candidate) => candidate >= required) ?? required
}
