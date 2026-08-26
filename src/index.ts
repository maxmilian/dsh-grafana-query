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

export { createGrafanaClient, GrafanaClient, normalizeAlertState } from './client.js'
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
