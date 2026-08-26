import { describe, expect, it } from 'vitest'

import { LOCALES } from '../src/config.js'
import { CONFIG_I18N, grafanaMessages } from '../src/locales.js'

const CONFIG_KEYS = [
  '$description',
  'baseUrl',
  'locale',
  'maxResponseBytes',
  'maxSeries',
  'requestTimeoutMs',
  'token',
]

describe('tool metadata locales', () => {
  it('exposes identical key sets across every locale', () => {
    const reference = Object.keys(grafanaMessages('en')).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(grafanaMessages(locale)).sort()).toEqual(reference)
    }
  })

  it('never returns an empty string', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(grafanaMessages(locale))) {
        expect(value, `${locale}.${key}`).toBeTypeOf('string')
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('mentions the step and point limits in every query_range description', () => {
    for (const locale of LOCALES) {
      const description = grafanaMessages(locale).queryRangeDescription
      expect(description).toMatch(/step/i)
      expect(description).toMatch(/200|point|點|点|ポイント/)
    }
  })

  it('mentions the default alert states in every alert_state description', () => {
    for (const locale of LOCALES) {
      const description = grafanaMessages(locale).alertStateDescription
      expect(description).toMatch(/firing/)
      expect(description).toMatch(/pending/)
      expect(description).toMatch(/unknown/)
    }
  })
})

describe('CONFIG_I18N', () => {
  it('covers all seven Schemastery locale keys with identical field sets', () => {
    expect(Object.keys(CONFIG_I18N).sort()).toEqual(
      ['en', 'en-US', 'ja', 'ja-JP', 'zh', 'zh-CN', 'zh-TW'].sort(),
    )
    for (const [locale, messages] of Object.entries(CONFIG_I18N)) {
      expect(Object.keys(messages).sort(), locale).toEqual(CONFIG_KEYS)
    }
  })

  it('names the environment variables in every locale', () => {
    for (const messages of Object.values(CONFIG_I18N)) {
      expect(messages.baseUrl).toContain('GRAFANA_URL')
      expect(messages.token).toContain('GRAFANA_TOKEN')
    }
  })
})
