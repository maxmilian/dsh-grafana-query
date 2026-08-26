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
  /** Grafana base URL. Falls back to GRAFANA_URL. */
  readonly baseUrl?: string
  /** Grafana service account token. Falls back to GRAFANA_TOKEN. */
  readonly token?: string
  /** Language used for tool descriptions. */
  readonly locale?: Locale
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs?: number
  /** Maximum successful response body size in bytes. */
  readonly maxResponseBytes?: number
  /** Maximum number of series returned by a single query. */
  readonly maxSeries?: number
}

/** Fully validated runtime configuration. */
export interface ResolvedGrafanaConfig {
  /** Normalized Grafana base URL with a trailing slash. */
  readonly baseUrl: string
  /** Non-empty Grafana token. */
  readonly token: string
  /** Validated tool metadata locale. */
  readonly locale: Locale
  /** Validated per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number
  /** Validated maximum successful response body size in bytes. */
  readonly maxResponseBytes: number
  /** Validated maximum number of series per query. */
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
  return {
    ...config,
    baseUrl: normalizeBaseUrl(config.baseUrl.trim()),
    token: config.token.trim(),
  }
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
