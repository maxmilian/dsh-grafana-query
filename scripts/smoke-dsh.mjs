// Live verification probes for spec section 11 (L1-L12). Driven by
// scripts/smoke-dsh.sh, which supplies the environment and builds lib/ first.
//
// Read-only: every probe is a GET through GrafanaClient. Nothing here writes to
// Grafana or to disk; results go to stdout for a human to paste into the
// verification note.
import { GrafanaClient, resolveConfig } from '../lib/client.js'

const env = process.env
const label = env.GRAFANA_LABEL ?? env.GRAFANA_URL
const uid = env.GRAFANA_DATASOURCE_UID
const results = []

/** Records one L-item outcome. */
function record(id, status, detail) {
  results.push({ id, status, detail })
  console.log(`${id.padEnd(4)} ${status.padEnd(5)} ${detail}`)
}

/** Runs a probe, turning any thrown GrafanaApiError into a readable detail line. */
async function probe(id, requirement, run) {
  if (requirement) return record(id, 'SKIP', `set ${requirement} to run this check`)
  try {
    record(id, 'OK', await run())
  } catch (error) {
    const code = error?.code ?? error?.name ?? 'Error'
    record(id, 'FAIL', `${code}: ${error?.message ?? error} (status ${error?.status ?? '-'})`)
  }
}

/** Builds a client and remembers the URLs it requests, for L2. */
function clientFor(token) {
  const seen = []
  const config = resolveConfig({ token }, env)
  const client = new GrafanaClient(config, (input, init) => {
    seen.push(String(input))
    return fetch(input, init)
  })
  return { client, seen, config }
}

const main = clientFor(env.GRAFANA_TOKEN)
const need = (name) => (env[name] ? undefined : name)

console.log(`# dsh-grafana-query live verification - ${label}`)
console.log(`# ${new Date().toISOString()}`)
console.log()

await probe('L1', need('GRAFANA_DATASOURCE_UID'), async () => {
  const result = await main.client.query({ datasourceUid: uid, query: 'up' })
  return `resultType=${result.data.resultType} series=${result.meta.seriesReturned} (native Prometheus JSON, not a dataframe)`
})

await probe('L2', undefined, async () => {
  await main.client.health()
  const healthUrl = main.seen.find((url) => url.endsWith('/api/health'))
  return `baseUrl=${main.config.baseUrl} composed=${healthUrl}`
})

await probe('L3', need('GRAFANA_DATASOURCE_UID'), async () => {
  try {
    await main.client.query({ datasourceUid: uid, query: 'up(' })
    return 'UNEXPECTED: a malformed query was accepted'
  } catch (error) {
    return `status=${error.status} code=${error.code} errorType=${error.errorType} upstreamMessage=${JSON.stringify(error.upstreamMessage)}`
  }
})

await probe('L4', need('GRAFANA_DATASOURCE_UID'), async () => {
  const end = Math.floor(Date.now() / 1_000)
  try {
    await main.client.queryRange({
      datasourceUid: uid,
      query: env.GRAFANA_BIG_QUERY ?? '{__name__=~".+"}',
      start: String(end - 30 * 86_400),
      end: String(end),
      maxPoints: 500,
    })
    return 'HTTP 200: the backend answered an oversized query instead of rejecting it'
  } catch (error) {
    return `status=${error.status} code=${error.code} errorType=${error.errorType}`
  }
})

await probe('L5', undefined, async () => {
  const result = await main.client.alertState({
    state: ['firing', 'pending', 'inactive', 'unknown'],
  })
  const raw = result.data.rules.filter((rule) => rule.stateRaw).map((rule) => rule.stateRaw)
  return `stateVocabulary=${result.meta.stateVocabulary} counts=${JSON.stringify(result.meta.counts)} unrecognized=${JSON.stringify([...new Set(raw)])}`
})

await probe('L6', undefined, async () => {
  const result = await main.client.listAlertRules({ includeQuery: true, pageSize: 5 })
  const nodes = result.data.rules.flatMap((rule) => rule.data ?? [])
  return `total=${result.meta.total} queryNodes=${nodes.length} withExpr=${nodes.filter((node) => node.expr).length} expressionNodes=${nodes.filter((node) => node.type).length}`
})

await probe('L7', undefined, async () => {
  const result = await main.client.listDatasources({ pageSize: 100 })
  const types = result.data.datasources.map((entry) => entry.type)
  return `total=${result.meta.total} types=${JSON.stringify([...new Set(types)])} names=${JSON.stringify(result.data.datasources.slice(0, 5).map((entry) => entry.name))}`
})

await probe('L8', need('GRAFANA_NON_PROM_DATASOURCE_UID'), async () => {
  try {
    await main.client.query({ datasourceUid: env.GRAFANA_NON_PROM_DATASOURCE_UID, query: 'up' })
    return 'UNEXPECTED: a non-Prometheus data source answered the query API'
  } catch (error) {
    return `status=${error.status ?? '-'} code=${error.code} message=${error.message}`
  }
})

await probe('L9', need('GRAFANA_LEGACY_API_KEY'), async () => {
  const legacy = clientFor(env.GRAFANA_LEGACY_API_KEY)
  const body = await legacy.client.health()
  return `legacy API key accepted: version=${body.data.version}`
})

await probe('L10', need('GRAFANA_DATASOURCE_UID'), async () => {
  const codes = []
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await main.client.query({ datasourceUid: uid, query: 'up' })
      codes.push('200')
    } catch (error) {
      codes.push(String(error.status ?? error.code))
    }
  }
  const rateLimited = codes.filter((code) => code === '429').length
  return `20 sequential queries, 429 responses=${rateLimited}`
})

await probe('L11', need('GRAFANA_BIG_QUERY'), async () => {
  const before = process.memoryUsage().heapUsed
  try {
    await main.client.query({ datasourceUid: uid, query: env.GRAFANA_BIG_QUERY })
    return 'the response fit inside maxResponseBytes; try a larger GRAFANA_BIG_QUERY'
  } catch (error) {
    const growth = Math.round((process.memoryUsage().heapUsed - before) / 1_048_576)
    return `code=${error.code} heapGrowth=${growth}MB (expected RESPONSE_TOO_LARGE with a small heap growth)`
  }
})

await probe('L12', need('GRAFANA_QUERY_ONLY_TOKEN'), async () => {
  if (!uid) return 'set GRAFANA_DATASOURCE_UID as well to run this check'
  const limited = clientFor(env.GRAFANA_QUERY_ONLY_TOKEN)
  const result = await limited.client.query({ datasourceUid: uid, query: 'up' })
  const metadata = limited.seen.filter((url) => url.includes('/api/datasources/uid/')).length
  return `query succeeded through the 403 degrade path: metadataRequests=${metadata} series=${result.meta.seriesReturned}`
})

console.log()
const failed = results.filter((entry) => entry.status === 'FAIL').length
const skipped = results.filter((entry) => entry.status === 'SKIP').length
console.log(`# ${results.length - failed - skipped} ok, ${failed} failed, ${skipped} skipped`)
process.exitCode = failed > 0 ? 1 : 0
