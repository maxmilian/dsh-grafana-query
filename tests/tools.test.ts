import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import type { GrafanaClient } from '../src/client.js'
import type { Locale } from '../src/config.js'
import { grafanaMessages } from '../src/locales.js'
import { registerGrafanaTools } from '../src/tools.js'

const TOOL_NAMES = [
  'grafana_alert_state',
  'grafana_health',
  'grafana_list_alert_rules',
  'grafana_list_datasources',
  'grafana_query',
  'grafana_query_range',
]

type AnyTool = {
  name: string
  description: string
  isConcurrencySafe?: (args: Record<string, unknown>) => boolean
  output?: { render?: (args: unknown, value: unknown) => unknown }
  execute: (args: Record<string, unknown>, exec: { signal?: AbortSignal }) => Promise<unknown>
}

function collect(locale: Locale = 'en') {
  const register = vi.fn()
  const client = {
    health: vi.fn(async () => ({ data: {}, meta: {} })),
    listDatasources: vi.fn(async () => ({ data: {}, meta: {} })),
    query: vi.fn(async () => ({ data: {}, meta: {} })),
    queryRange: vi.fn(async () => ({ data: {}, meta: {} })),
    alertState: vi.fn(async () => ({ data: {}, meta: {} })),
    listAlertRules: vi.fn(async () => ({ data: {}, meta: {} })),
  }
  registerGrafanaTools(
    { tools: { register } } as unknown as Context,
    client as unknown as GrafanaClient,
    locale,
  )
  const tools = register.mock.calls.map((call) => call[0] as AnyTool)
  return { tools, client, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

describe('registerGrafanaTools', () => {
  it('registers exactly the six read-only tools', () => {
    const { tools } = collect()
    expect(tools).toHaveLength(6)
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)
  })

  const VALID_ARGS: Record<string, Record<string, unknown>> = {
    grafana_health: {},
    grafana_list_datasources: { type: 'prometheus' },
    grafana_query: { datasource_uid: 'prom-1', query: 'up' },
    grafana_query_range: {
      datasource_uid: 'prom-1',
      query: 'up',
      start: '1700000000',
      end: '1700003600',
    },
    grafana_alert_state: { state: ['firing'] },
    grafana_list_alert_rules: { rule_group: 'cpu' },
  }

  it('marks every tool as concurrency safe', () => {
    for (const tool of collect().tools) {
      expect(tool.isConcurrencySafe?.(VALID_ARGS[tool.name] ?? {}), tool.name).toBe(true)
    }
  })

  it('renders results as a single JSON text block', () => {
    const tool = collect().byName.get('grafana_health')
    const value = { data: { database: 'ok' }, meta: {} }
    const rendered = tool?.output?.render?.({}, value) as { type: string; text: string }[]

    expect(rendered).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(JSON.parse(rendered[0]?.text ?? '')).toEqual(value)
  })

  it('maps snake_case arguments onto camelCase client parameters', async () => {
    const { byName, client } = collect()
    await byName.get('grafana_query_range')?.execute(
      {
        datasource_uid: 'prom-1',
        query: 'up',
        start: '1700000000',
        end: '1700003600',
        step: '1m',
        max_points: 50,
      },
      { signal: undefined },
    )

    expect(client.queryRange).toHaveBeenCalledWith(
      {
        datasourceUid: 'prom-1',
        query: 'up',
        start: '1700000000',
        end: '1700003600',
        step: '1m',
        maxPoints: 50,
      },
      undefined,
    )
  })

  it('switches descriptions with the locale but keeps tool names in English', () => {
    const zh = collect('zh-TW')
    expect(zh.byName.get('grafana_query_range')?.description).toBe(
      grafanaMessages('zh-TW').queryRangeDescription,
    )
    expect(zh.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)
  })

  it('describes the enforced limits in every locale', () => {
    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ja'] as const) {
      const description = collect(locale).byName.get('grafana_query_range')?.description ?? ''
      expect(description).toMatch(/step/i)
    }
  })
})
