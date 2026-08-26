import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { GrafanaClient } from './client.js'
import type { Locale } from './config.js'
import { type GrafanaMessages, grafanaMessages } from './locales.js'
import type { JsonValue } from './types.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: { type: 'json', required: true },
    meta: { type: 'json', required: true },
  },
} as const

const ALERT_STATES = ['firing', 'pending', 'inactive', 'unknown'] as const

/** Registers all read-only Grafana tools on a DSH tools service. */
export function registerGrafanaTools(ctx: Context, client: GrafanaClient, locale: Locale): void {
  const messages = grafanaMessages(locale)
  registerHealth(ctx, client, messages)
  registerListDatasources(ctx, client, messages)
  registerQuery(ctx, client, messages)
  registerQueryRange(ctx, client, messages)
  registerAlertState(ctx, client, messages)
  registerListAlertRules(ctx, client, messages)
}

function pageParameters(messages: GrafanaMessages) {
  return {
    page: { type: 'integer', description: messages.page },
    page_size: { type: 'integer', description: messages.pageSize },
  } as const
}

function registerHealth(ctx: Context, client: GrafanaClient, messages: GrafanaMessages): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_health',
      description: messages.healthDescription,
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (_args, exec) => client.health(exec.signal),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.healthTitle, kind: 'read' }),
    }),
  )
}

function registerListDatasources(
  ctx: Context,
  client: GrafanaClient,
  messages: GrafanaMessages,
): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_list_datasources',
      description: messages.datasourcesDescription,
      parameters: {
        type: { type: 'string', description: messages.type },
        name_contains: { type: 'string', description: messages.nameContains },
        ...pageParameters(messages),
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (args, exec) =>
        client.listDatasources(
          {
            type: args.type,
            nameContains: args.name_contains,
            page: args.page,
            pageSize: args.page_size,
          },
          exec.signal,
        ),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.datasourcesTitle, kind: 'search' }),
    }),
  )
}

function registerQuery(ctx: Context, client: GrafanaClient, messages: GrafanaMessages): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_query',
      description: messages.queryDescription,
      parameters: {
        datasource_uid: { type: 'string', required: true, description: messages.datasourceUid },
        query: { type: 'string', required: true, description: messages.query },
        time: { type: 'string', description: messages.time },
        timeout: { type: 'string', description: messages.timeout },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (args, exec) =>
        client.query(
          {
            datasourceUid: args.datasource_uid,
            query: args.query,
            time: args.time,
            timeout: args.timeout,
          },
          exec.signal,
        ),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.queryTitle, kind: 'read' }),
    }),
  )
}

function registerQueryRange(ctx: Context, client: GrafanaClient, messages: GrafanaMessages): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_query_range',
      description: messages.queryRangeDescription,
      parameters: {
        datasource_uid: { type: 'string', required: true, description: messages.datasourceUid },
        query: { type: 'string', required: true, description: messages.query },
        start: { type: 'string', required: true, description: messages.start },
        end: { type: 'string', required: true, description: messages.end },
        step: { type: 'string', description: messages.step },
        max_points: { type: 'integer', description: messages.maxPoints },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (args, exec) =>
        client.queryRange(
          {
            datasourceUid: args.datasource_uid,
            query: args.query,
            start: args.start,
            end: args.end,
            step: args.step,
            maxPoints: args.max_points,
          },
          exec.signal,
        ),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.queryRangeTitle, kind: 'read' }),
    }),
  )
}

function registerAlertState(ctx: Context, client: GrafanaClient, messages: GrafanaMessages): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_alert_state',
      description: messages.alertStateDescription,
      parameters: {
        state: {
          type: 'array',
          items: { type: 'string', enum: ALERT_STATES },
          description: messages.state,
        },
        folder_contains: { type: 'string', description: messages.folderContains },
        rule_contains: { type: 'string', description: messages.ruleContains },
        include_instances: { type: 'boolean', description: messages.includeInstances },
        max_instances_per_rule: { type: 'integer', description: messages.maxInstancesPerRule },
        ...pageParameters(messages),
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (args, exec) =>
        client.alertState(
          {
            state: args.state,
            folderContains: args.folder_contains,
            ruleContains: args.rule_contains,
            includeInstances: args.include_instances,
            maxInstancesPerRule: args.max_instances_per_rule,
            page: args.page,
            pageSize: args.page_size,
          },
          exec.signal,
        ),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.alertStateTitle, kind: 'read' }),
    }),
  )
}

function registerListAlertRules(
  ctx: Context,
  client: GrafanaClient,
  messages: GrafanaMessages,
): void {
  ctx.tools.register(
    defineTool({
      name: 'grafana_list_alert_rules',
      description: messages.alertRulesDescription,
      parameters: {
        folder_uid: { type: 'string', description: messages.folderUid },
        rule_group: { type: 'string', description: messages.ruleGroup },
        title_contains: { type: 'string', description: messages.titleContains },
        include_query: { type: 'boolean', description: messages.includeQuery },
        ...pageParameters(messages),
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: (args, exec) =>
        client.listAlertRules(
          {
            folderUid: args.folder_uid,
            ruleGroup: args.rule_group,
            titleContains: args.title_contains,
            includeQuery: args.include_query,
            page: args.page,
            pageSize: args.page_size,
          },
          exec.signal,
        ),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: messages.alertRulesTitle, kind: 'search' }),
    }),
  )
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
