import type { JsonValue } from './types.js'

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
  return new GrafanaApiError(`Invalid Grafana configuration: ${message}`, {
    code: 'INVALID_CONFIG',
  })
}

/** Creates an input validation error with a stable prefix. */
export function inputError(message: string): GrafanaApiError {
  return new GrafanaApiError(`Invalid Grafana input: ${message}`, { code: 'INVALID_INPUT' })
}

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
  /(authorization|bearer|api[-_]?key|password|secret|token)\s*[:=]?\s*\S+/gi,
]

/** Creates a safe error for an unsuccessful HTTP response. */
export function createHttpError(status: number, retryAfter?: string): GrafanaApiError {
  const descriptor = describeHttpError(status)
  return new GrafanaApiError(descriptor.message, { code: descriptor.code, status, retryAfter })
}

function describeHttpError(status: number): { code: GrafanaErrorCode; message: string } {
  if (status === 401) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: 'Grafana authentication failed. Check GRAFANA_TOKEN.',
    }
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

/**
 * Restates a 403 with the Grafana permission the service account is missing.
 * Anything that is not a permission failure passes through untouched.
 */
export function permissionError(error: unknown, permission: string): unknown {
  if (!(error instanceof GrafanaApiError) || error.code !== 'PERMISSION_DENIED') return error
  return new GrafanaApiError(
    `Grafana denied access to this resource. The token needs the ${permission} permission.`,
    { code: 'PERMISSION_DENIED', status: error.status },
  )
}

/** Creates an error for a Prometheus `status: "error"` response body. */
export function createUpstreamError(
  status: number,
  body: JsonValue,
  token: string,
): GrafanaApiError {
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
  const field = readField(body, 'errorType')
  return typeof field === 'string' && ERROR_TYPES.has(field) ? field : undefined
}

function readUpstreamMessage(body: JsonValue, token: string): string | undefined {
  const raw = readField(body, 'error')
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  if (raw.includes(token)) return undefined
  return truncate(redact(raw))
}

function readField(body: JsonValue, key: string): JsonValue | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  return (body as Record<string, JsonValue>)[key]
}

function redact(value: string): string | undefined {
  let result = value
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]')
  const visible = result.replaceAll('[redacted]', '').replace(/\s+/g, '')
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
