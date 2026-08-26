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
