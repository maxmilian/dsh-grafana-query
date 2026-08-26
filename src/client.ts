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
