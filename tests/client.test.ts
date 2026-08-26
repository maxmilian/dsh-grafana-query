import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chooseStepSeconds,
  createGrafanaClient,
  GrafanaClient,
  parseDurationMs,
  parseStepSeconds,
} from '../src/client.js'
import type { ResolvedGrafanaConfig } from '../src/config.js'
import type { GrafanaApiError } from '../src/errors.js'

type MockFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const BASE_CONFIG: ResolvedGrafanaConfig = {
  baseUrl: 'https://grafana.example.com/grafana/',
  token: 'glsa_secret',
  locale: 'en',
  requestTimeoutMs: 1_000,
  maxResponseBytes: 10_000,
  maxSeries: 100,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function clientWith(fetchImpl: MockFetch, overrides: Partial<ResolvedGrafanaConfig> = {}) {
  return new GrafanaClient({ ...BASE_CONFIG, ...overrides }, fetchImpl)
}

async function captureError(promise: Promise<unknown>): Promise<GrafanaApiError> {
  try {
    await promise
    throw new Error('expected the call to reject')
  } catch (error) {
    return error as GrafanaApiError
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('health', () => {
  it('calls /api/health under the configured sub-path with a bearer token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ database: 'ok', version: '11.3.0', commit: 'abc' }),
    )
    const result = await clientWith(fetchImpl).health()

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://grafana.example.com/grafana/api/health')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer glsa_secret')
    expect(result).toEqual({ data: { database: 'ok', version: '11.3.0' }, meta: {} })
  })

  it('maps HTTP failures to stable codes without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const error = await captureError(clientWith(fetchImpl).health())

    expect(error.code).toBe('AUTHENTICATION_FAILED')
    expect(JSON.stringify(error)).not.toContain('glsa_secret')
    expect(error.message).not.toContain('glsa_secret')
  })

  it.each([
    ['text/html', '<html>login</html>'],
    ['application/json', '{oops'],
  ])('rejects unusable %s responses', async (contentType, body) => {
    const fetchImpl = vi.fn(
      async () => new Response(body, { headers: { 'content-type': contentType } }),
    )
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('INVALID_RESPONSE')
  })

  it.each([['"ok"'], ['42'], ['null'], ['true']])(
    'rejects scalar JSON top level %s',
    async (body) => {
      const fetchImpl = vi.fn(
        async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
      )
      expect((await captureError(clientWith(fetchImpl).health())).code).toBe('INVALID_RESPONSE')
    },
  )

  it('rejects an array where an object is expected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ database: 'ok' }]))
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('INVALID_RESPONSE')
  })

  it('reports a timeout instead of a network error', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const promise = captureError(clientWith(fetchImpl).health())
    await vi.advanceTimersByTimeAsync(1_001)
    expect((await promise).code).toBe('REQUEST_TIMEOUT')
  })

  it('reports caller cancellation as REQUEST_ABORTED', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const promise = captureError(clientWith(fetchImpl).health(controller.signal))
    controller.abort()
    expect((await promise).code).toBe('REQUEST_ABORTED')
  })

  it('reports unreachable hosts as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('NETWORK_ERROR')
  })

  it('rejects bodies larger than maxResponseBytes via Content-Length', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '20000' },
        }),
    )
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe('RESPONSE_TOO_LARGE')
  })

  it('cancels a streaming body that exceeds maxResponseBytes', async () => {
    const cancel = vi.fn()
    const chunk = new TextEncoder().encode('x'.repeat(600))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel,
    })
    const fetchImpl = vi.fn(
      async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    )
    const error = await captureError(clientWith(fetchImpl, { maxResponseBytes: 1_000 }).health())

    expect(error.code).toBe('RESPONSE_TOO_LARGE')
    expect(cancel).toHaveBeenCalled()
  })

  it('creates a client from environment variables', () => {
    const client = createGrafanaClient(
      {},
      { GRAFANA_URL: 'https://g.example.com', GRAFANA_TOKEN: 't' },
      vi.fn(),
    )
    expect(client).toBeInstanceOf(GrafanaClient)
  })
})

const DATASOURCES = [
  {
    uid: 'prom-1',
    name: 'Prometheus Prod',
    type: 'prometheus',
    isDefault: true,
    access: 'proxy',
    readOnly: false,
    url: 'https://user:pass@prom.example.com',
    password: 'hunter2',
    basicAuthPassword: 'hunter2',
    secureJsonFields: { httpHeaderValue1: true },
    jsonData: { httpMethod: 'POST' },
    typeLogoUrl: 'public/img/prom.svg',
  },
  {
    uid: 'loki-1',
    name: 'Loki',
    type: 'loki',
    isDefault: false,
    access: 'proxy',
    readOnly: false,
    url: 'https://loki.example.com',
  },
  {
    uid: 'browser-1',
    name: 'Direct',
    type: 'prometheus',
    isDefault: false,
    access: 'direct',
    readOnly: true,
    url: 'https://direct.example.com',
  },
]

describe('listDatasources', () => {
  it('whitelists safe fields and strips credentials from the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    const result = await clientWith(fetchImpl).listDatasources({})
    const serialized = JSON.stringify(result)

    expect(serialized).not.toMatch(
      /password|basicAuthPassword|secureJsonFields|jsonData|typeLogoUrl|hunter2/,
    )
    expect((result.data as { datasources: unknown[] }).datasources[0]).toEqual({
      uid: 'prom-1',
      name: 'Prometheus Prod',
      type: 'prometheus',
      isDefault: true,
      access: 'proxy',
      readOnly: false,
      url: 'https://prom.example.com/',
    })
  })

  it('omits the URL for direct-access data sources', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    const result = await clientWith(fetchImpl).listDatasources({ nameContains: 'direct' })
    expect(
      (result.data as { datasources: Record<string, unknown>[] }).datasources[0],
    ).not.toHaveProperty('url')
  })

  it('filters by type and name before paginating', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    const result = await clientWith(fetchImpl).listDatasources({
      type: 'PROMETHEUS',
      pageSize: 1,
      page: 2,
    })

    expect(result.meta).toEqual({ total: 2, page: 2, pageSize: 1 })
    expect(result.meta).not.toHaveProperty('truncated')
    const uids = (result.data as { datasources: { uid: string }[] }).datasources.map((d) => d.uid)
    expect(uids).toEqual(['browser-1'])
  })

  it('accepts a top-level JSON array without raising INVALID_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await expect(clientWith(fetchImpl).listDatasources({})).resolves.toMatchObject({
      meta: { total: 0 },
    })
  })

  it.each([
    [{ page: 0 }],
    [{ pageSize: 0 }],
    [{ pageSize: 101 }],
    [{ nameContains: 'x'.repeat(201) }],
  ])('rejects invalid pagination or filters %o', async (params) => {
    const fetchImpl = vi.fn(async () => jsonResponse(DATASOURCES))
    expect((await captureError(clientWith(fetchImpl).listDatasources(params))).code).toBe(
      'INVALID_INPUT',
    )
  })
})

describe('duration parsing', () => {
  it.each([
    ['30', 30_000],
    ['500ms', 500],
    ['15s', 15_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
  ])('parses %s', (value, expected) => {
    expect(parseDurationMs('timeout', value)).toBe(expected)
  })

  it.each(['1h30m', '1.5h', '-5s', '1y', '', 'abc', '10 s'])('rejects %s', (value) => {
    expect(() => parseDurationMs('timeout', value)).toThrow(/timeout/)
  })

  it.each(['500ms', '1000ms'])('rejects %s as a step because ms is not allowed', (value) => {
    expect(() => parseStepSeconds(value)).toThrow(/ms/)
  })

  it.each([
    ['15s', 15],
    ['5m', 300],
    ['1h', 3_600],
    ['60', 60],
  ])('parses step %s into seconds', (value, expected) => {
    expect(parseStepSeconds(value)).toBe(expected)
  })
})

describe('chooseStepSeconds', () => {
  it.each([
    [60, 200, 1],
    [1_000, 200, 5],
    [3_600, 200, 30],
    [86_400, 200, 600],
    [7 * 86_400, 200, 3_600],
    [31 * 86_400, 200, 21_600],
  ])('picks the ladder step for range %s and %s points', (rangeSeconds, maxPoints, expected) => {
    expect(chooseStepSeconds(rangeSeconds, maxPoints)).toBe(expected)
  })

  it('falls back to the exact required step beyond one day', () => {
    expect(chooseStepSeconds(31 * 86_400, 2)).toBe(Math.ceil((31 * 86_400) / 2))
  })
})

const PROM_META = { uid: 'prom-1', name: 'P', type: 'prometheus', access: 'proxy' }
const VECTOR_OK = { status: 'success', data: { resultType: 'vector', result: [] } }

function routed(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    const handler = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1]
    if (!handler) throw new Error(`unexpected request to ${path}`)
    return handler()
  })
}

describe('data source pre-flight checks', () => {
  it('rejects non-Prometheus data sources without issuing the query', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/loki-1': () => jsonResponse({ type: 'loki', access: 'proxy' }),
    })
    const error = await captureError(
      clientWith(fetchImpl).query({ datasourceUid: 'loki-1', query: 'up' }),
    )

    expect(error.code).toBe('DATASOURCE_TYPE_UNSUPPORTED')
    expect(error.message).toContain('loki')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects direct-access data sources without issuing the query', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/d-1': () => jsonResponse({ type: 'prometheus', access: 'direct' }),
    })
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: 'd-1', query: 'up' }))).code,
    ).toBe('DATASOURCE_NOT_PROXYABLE')
  })

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [404, 'NOT_FOUND'],
  ])('propagates metadata HTTP %s as %s', async (status, code) => {
    const fetchImpl = routed({ '/api/datasources/uid/x': () => new Response('', { status }) })
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: 'x', query: 'up' }))).code,
    ).toBe(code)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when metadata is forbidden and still runs the query', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => jsonResponse(VECTOR_OK),
    })
    await expect(
      clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }),
    ).resolves.toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not cache a degraded lookup', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => jsonResponse(VECTOR_OK),
    })
    const client = clientWith(fetchImpl)
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('caches successful metadata for the lifetime of the client', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(VECTOR_OK),
    })
    const client = clientWith(fetchImpl)
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    await client.query({ datasourceUid: 'prom-1', query: 'up' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps a proxy 404 to a type error when metadata succeeded', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => new Response('', { status: 404 }),
    })
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })))
        .code,
    ).toBe('DATASOURCE_TYPE_UNSUPPORTED')
  })

  it('maps a proxy 404 to NOT_FOUND when metadata was unavailable', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => new Response('', { status: 404 }),
    })
    const error = await captureError(
      clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }),
    )

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toMatch(/uid/i)
    expect(error.message).toMatch(/Prometheus/i)
  })

  it.each([['bad uid!'], [''], ['x'.repeat(101)]])('rejects malformed uid %s', async (uid) => {
    const fetchImpl = vi.fn()
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: uid, query: 'up' }))).code,
    ).toBe('INVALID_INPUT')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

function vector(count: number) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: Array.from({ length: count }, (_, index) => ({
        metric: { __name__: 'up', instance: `host-${index}` },
        value: [1_700_000_000, '1'],
      })),
    },
  }
}

describe('query', () => {
  it('builds the uid proxy URL and forwards the PromQL expression', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(vector(1)),
    })
    await clientWith(fetchImpl).query({
      datasourceUid: 'prom-1',
      query: 'up',
      time: '1700000000',
    })

    const url = new URL(String(fetchImpl.mock.calls[1]?.[0]))
    expect(url.pathname).toBe('/grafana/api/datasources/proxy/uid/prom-1/api/v1/query')
    expect(url.searchParams.get('query')).toBe('up')
    expect(url.searchParams.get('time')).toBe('1700000000')
  })

  it('truncates series beyond maxSeries and records the total', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(vector(150)),
    })
    const result = await clientWith(fetchImpl, { maxResponseBytes: 1_000_000 }).query({
      datasourceUid: 'prom-1',
      query: 'up',
    })

    expect((result.data as { result: unknown[] }).result).toHaveLength(100)
    expect(result.meta).toMatchObject({ seriesReturned: 100, seriesTotal: 150, truncated: true })
    expect(result.meta.hint).toBeTypeOf('string')
  })

  it('honours a lowered maxSeries from configuration', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(vector(150)),
    })
    const result = await clientWith(fetchImpl, {
      maxSeries: 5,
      maxResponseBytes: 1_000_000,
    }).query({
      datasourceUid: 'prom-1',
      query: 'up',
    })
    expect((result.data as { result: unknown[] }).result).toHaveLength(5)
  })

  it('exposes the upstream error for HTTP 400 only', async () => {
    const body = { status: 'error', errorType: 'bad_data', error: 'parse error at char 3' }
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(body, { status: 400 }),
    })
    const error = await captureError(
      clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up(' }),
    )

    expect(error.code).toBe('UPSTREAM_QUERY_FAILED')
    expect(error.upstreamMessage).toBe('parse error at char 3')
  })

  it.each([[422], [200]])('hides the upstream error text for HTTP %s', async (status) => {
    const body = { status: 'error', errorType: 'execution', error: 'too many samples' }
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(body, { status }),
    })
    const error = await captureError(
      clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }),
    )

    expect(error.code).toBe('UPSTREAM_QUERY_FAILED')
    expect(error.errorType).toBe('execution')
    expect(error.upstreamMessage).toBeUndefined()
  })

  it('collects Prometheus warnings into meta', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse({ ...vector(1), warnings: ['partial data'] }),
    })
    const result = await clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })
    expect(result.meta.warnings).toEqual(['partial data'])
  })

  it.each([
    [{ query: '' }],
    [{ query: 'x'.repeat(4_001) }],
    [{ timeout: '2h' }],
    [{ timeout: '1h30m' }],
  ])('rejects invalid arguments %o', async (overrides) => {
    const fetchImpl = vi.fn()
    const params = { datasourceUid: 'prom-1', query: 'up', ...overrides }
    expect((await captureError(clientWith(fetchImpl).query(params))).code).toBe('INVALID_INPUT')
  })
})
