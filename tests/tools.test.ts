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
  presentCall?: (args: Record<string, unknown>) => { card: string; title: string; kind: string }
}

type ClientMethod =
  | 'health'
  | 'listDatasources'
  | 'query'
  | 'queryRange'
  | 'alertState'
  | 'listAlertRules'

interface ExecuteCase {
  readonly tool: string
  readonly method: ClientMethod
  readonly args: Record<string, unknown>
  readonly expected: Record<string, unknown>
}

/** Every snake_case argument of every tool, with the camelCase call it must produce. */
const EXECUTE_CASES: readonly ExecuteCase[] = [
  {
    tool: 'grafana_list_datasources',
    method: 'listDatasources',
    args: { type: 'prometheus', name_contains: 'prod', page: 2, page_size: 50 },
    expected: { type: 'prometheus', nameContains: 'prod', page: 2, pageSize: 50 },
  },
  {
    tool: 'grafana_query',
    method: 'query',
    args: { datasource_uid: 'prom-1', query: 'up', time: '1700000000', timeout: '10s' },
    expected: { datasourceUid: 'prom-1', query: 'up', time: '1700000000', timeout: '10s' },
  },
  {
    tool: 'grafana_query_range',
    method: 'queryRange',
    args: {
      datasource_uid: 'prom-1',
      query: 'up',
      start: '1700000000',
      end: '1700003600',
      step: '1m',
      max_points: 50,
    },
    expected: {
      datasourceUid: 'prom-1',
      query: 'up',
      start: '1700000000',
      end: '1700003600',
      step: '1m',
      maxPoints: 50,
    },
  },
  {
    tool: 'grafana_alert_state',
    method: 'alertState',
    args: {
      state: ['firing'],
      folder_contains: 'Infra',
      rule_contains: 'CPU',
      include_instances: false,
      max_instances_per_rule: 5,
      page: 3,
      page_size: 25,
    },
    expected: {
      state: ['firing'],
      folderContains: 'Infra',
      ruleContains: 'CPU',
      includeInstances: false,
      maxInstancesPerRule: 5,
      page: 3,
      pageSize: 25,
    },
  },
  {
    tool: 'grafana_list_alert_rules',
    method: 'listAlertRules',
    args: {
      folder_uid: 'folder-1',
      rule_group: 'cpu',
      title_contains: 'High',
      include_query: true,
      page: 4,
      page_size: 10,
    },
    expected: {
      folderUid: 'folder-1',
      ruleGroup: 'cpu',
      titleContains: 'High',
      includeQuery: true,
      page: 4,
      pageSize: 10,
    },
  },
]

const PRESENT_CASES = [
  { tool: 'grafana_health', title: 'healthTitle', kind: 'read' },
  { tool: 'grafana_list_datasources', title: 'datasourcesTitle', kind: 'search' },
  { tool: 'grafana_query', title: 'queryTitle', kind: 'read' },
  { tool: 'grafana_query_range', title: 'queryRangeTitle', kind: 'read' },
  { tool: 'grafana_alert_state', title: 'alertStateTitle', kind: 'read' },
  { tool: 'grafana_list_alert_rules', title: 'alertRulesTitle', kind: 'search' },
] as const

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

  it.each(EXECUTE_CASES)(
    '$tool maps every snake_case argument onto its camelCase parameter',
    async ({ tool, method, args, expected }) => {
      const { byName, client } = collect()
      const signal = new AbortController().signal
      const result = await byName.get(tool)?.execute(args, { signal })

      expect(client[method]).toHaveBeenCalledWith(expected, signal)
      expect(result).toEqual({ data: {}, meta: {} })
    },
  )

  it('passes only the abort signal for the parameterless health tool', async () => {
    const { byName, client } = collect()
    const signal = new AbortController().signal
    await byName.get('grafana_health')?.execute({}, { signal })

    expect(client.health).toHaveBeenCalledWith(signal)
  })

  it.each(PRESENT_CASES)(
    '$tool presents a $kind card with its localized title',
    ({ tool, title, kind }) => {
      for (const locale of ['en', 'zh-TW', 'zh-CN', 'ja'] as const) {
        const args = VALID_ARGS[tool] ?? {}
        expect(collect(locale).byName.get(tool)?.presentCall?.(args), `${locale}.${tool}`).toEqual({
          card: 'generic',
          title: grafanaMessages(locale)[title],
          kind,
        })
      }
    },
  )

  it.each(TOOL_NAMES)('%s carries the matching localized description', (tool) => {
    const key = {
      grafana_health: 'healthDescription',
      grafana_list_datasources: 'datasourcesDescription',
      grafana_query: 'queryDescription',
      grafana_query_range: 'queryRangeDescription',
      grafana_alert_state: 'alertStateDescription',
      grafana_list_alert_rules: 'alertRulesDescription',
    }[tool] as keyof ReturnType<typeof grafanaMessages>

    for (const locale of ['en', 'zh-TW', 'zh-CN', 'ja'] as const) {
      expect(collect(locale).byName.get(tool)?.description, `${locale}.${tool}`).toBe(
        grafanaMessages(locale)[key],
      )
    }
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
