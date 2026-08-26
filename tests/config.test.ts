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
    const resolved = resolveConfig(
      {},
      { GRAFANA_URL: 'https://env.example.com/g', GRAFANA_TOKEN: 't' },
    )
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
    expect(() => resolveConfig({ baseUrl: 'https://h.example.com' }, {})).toThrow(
      /token or GRAFANA_TOKEN/,
    )
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
