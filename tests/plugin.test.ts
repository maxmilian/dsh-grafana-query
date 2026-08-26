import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { apply, Config, inject, name } from '../src/index.js'

describe('DSH plugin entry', () => {
  it('exports the required identity and tools injection', () => {
    expect(name).toBe('dsh-grafana-query')
    expect(inject).toEqual(['tools'])
    expect(Config).toBeDefined()
  })

  it('exposes localized configuration descriptions', () => {
    expect(Config.meta.description).toMatchObject({
      en: expect.stringContaining('Grafana'),
      'zh-TW': expect.any(String),
      'zh-CN': expect.any(String),
      'ja-JP': expect.any(String),
    })
    expect(Config.dict?.token?.meta.role).toBe('secret')
    expect(Config.dict?.token?.meta.description).toMatchObject({
      en: expect.stringContaining('GRAFANA_TOKEN'),
      'zh-TW': expect.stringContaining('GRAFANA_TOKEN'),
    })
  })

  it('declares the documented numeric bounds', () => {
    expect(Config.dict?.requestTimeoutMs?.meta).toMatchObject({
      default: 30_000,
      min: 1,
      max: 300_000,
      step: 1,
    })
    expect(Config.dict?.maxResponseBytes?.meta).toMatchObject({
      default: 5 * 1024 * 1024,
      min: 1,
      max: 50 * 1024 * 1024,
      step: 1,
    })
    expect(Config.dict?.maxSeries?.meta).toMatchObject({
      default: 100,
      min: 1,
      max: 1_000,
      step: 1,
    })
    expect(Config.dict?.locale?.meta.default).toBe('en')
  })

  it('registers six tools when applied', () => {
    const register = vi.fn()
    apply({ tools: { register } } as unknown as Context, {
      baseUrl: 'https://grafana.example.com',
      token: 'glsa_token',
    })
    expect(register).toHaveBeenCalledTimes(6)
  })

  it('fails fast on an invalid base URL', () => {
    const register = vi.fn()
    expect(() =>
      apply({ tools: { register } } as unknown as Context, { baseUrl: 'ftp://x', token: 't' }),
    ).toThrow(/Invalid Grafana configuration/)
  })
})
