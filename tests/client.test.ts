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
    [1_000, 200, 10],
    [3_600, 200, 30],
    [86_400, 200, 600],
    [7 * 86_400, 200, 3_600],
    [31 * 86_400, 200, 21_600],
  ])('picks the ladder step for range %s and %s points', (rangeSeconds, maxPoints, expected) => {
    expect(chooseStepSeconds(rangeSeconds, maxPoints)).toBe(expected)
  })

  it('falls back to the exact required step beyond one day', () => {
    expect(chooseStepSeconds(31 * 86_400, 2)).toBe(Math.ceil((31 * 86_400 + 1) / 2))
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

function matrix(seriesCount: number, pointsPerSeries: number) {
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: Array.from({ length: seriesCount }, (_, s) => ({
        metric: { instance: `host-${s}` },
        values: Array.from({ length: pointsPerSeries }, (_, p) => [1_700_000_000 + p * 15, '1']),
      })),
    },
  }
}

const RANGE = {
  datasourceUid: 'prom-1',
  query: 'up',
  start: '1700000000',
  end: '1700003600',
}

describe('queryRange', () => {
  it('derives a step from the range when none is given', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 10)),
    })
    const result = await clientWith(fetchImpl).queryRange(RANGE)

    const url = new URL(String(fetchImpl.mock.calls[1]?.[0]))
    expect(url.pathname.endsWith('/api/v1/query_range')).toBe(true)
    expect(url.searchParams.get('step')).toBe('30')
    expect(result.meta).toMatchObject({ stepApplied: 30, stepAuto: true, maxPoints: 200 })
  })

  it('sends an explicit step verbatim in whole seconds', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 10)),
    })
    const result = await clientWith(fetchImpl).queryRange({ ...RANGE, step: '5m' })

    const url = new URL(String(fetchImpl.mock.calls[1]?.[0]))
    expect(url.searchParams.get('step')).toBe('300')
    expect(result.meta).toMatchObject({ stepApplied: 300, stepAuto: false })
  })

  it('refuses an explicit step that would exceed max_points, before issuing any request', async () => {
    const fetchImpl = vi.fn()
    const error = await captureError(
      clientWith(fetchImpl).queryRange({ ...RANGE, step: '1s', maxPoints: 10 }),
    )

    expect(error.code).toBe('QUERY_RANGE_TOO_LARGE')
    expect(error.message).toContain('3601')
    expect(error.message).toContain('10')
    expect(error.message).toContain('361')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('trims whole series when the total point budget is exceeded', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(100, 500)),
    })
    const result = await clientWith(fetchImpl, { maxResponseBytes: 20_000_000 }).queryRange({
      ...RANGE,
      maxPoints: 500,
    })
    const series = (result.data as { result: { values: unknown[] }[] }).result

    expect(series).toHaveLength(40)
    expect(series.every((entry) => entry.values.length === 500)).toBe(true)
    expect(result.meta).toMatchObject({ truncated: true, totalPoints: 20_000, seriesTotal: 100 })
  })

  it('counts the inclusive end point when an explicit step is checked', async () => {
    const fetchImpl = vi.fn()
    const error = await captureError(
      clientWith(fetchImpl).queryRange({
        ...RANGE,
        start: '0',
        end: '200',
        step: '1s',
        maxPoints: 200,
      }),
    )

    expect(error.code).toBe('QUERY_RANGE_TOO_LARGE')
    expect(error.message).toContain('201')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts an explicit step that lands exactly on the point budget', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 200)),
    })
    const result = await clientWith(fetchImpl).queryRange({
      ...RANGE,
      start: '0',
      end: '199',
      step: '1s',
      maxPoints: 200,
    })

    expect(result.meta).toMatchObject({ stepApplied: 1, maxPoints: 200, totalPoints: 200 })
  })

  it('keeps an automatic step within the inclusive point budget', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 1)),
    })
    await clientWith(fetchImpl).queryRange({ ...RANGE, start: '0', end: '200', maxPoints: 200 })

    const step = Number(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get('step'))
    expect(Math.floor(200 / step) + 1).toBeLessThanOrEqual(200)
  })

  it('asks for a single point when max_points is 1', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query_range': () => jsonResponse(matrix(1, 1)),
    })
    await clientWith(fetchImpl).queryRange({ ...RANGE, start: '0', end: '200', maxPoints: 1 })

    const step = Number(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get('step'))
    expect(Math.floor(200 / step) + 1).toBe(1)
  })

  it.each([
    [{ start: '1700003600', end: '1700000000' }],
    [{ end: 'not-a-time' }],
    [{ step: '1h30m' }],
    [{ step: '500ms' }],
    [{ maxPoints: 0 }],
    [{ maxPoints: 501 }],
    [{ start: '1600000000' }],
  ])('rejects invalid range arguments %o', async (overrides) => {
    const fetchImpl = vi.fn()
    expect(
      (await captureError(clientWith(fetchImpl).queryRange({ ...RANGE, ...overrides }))).code,
    ).toBe('INVALID_INPUT')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

const RULES_BODY = {
  status: 'success',
  data: {
    groups: [
      {
        name: 'cpu',
        file: 'Infra',
        rules: [
          {
            name: 'HighCPU',
            state: 'firing',
            health: 'ok',
            labels: { severity: 'critical' },
            annotations: {
              summary: 'CPU is high',
              description: 'd',
              runbook_url: 'r',
              internal: 'x',
            },
            lastEvaluation: '2026-08-26T00:00:00Z',
            evaluationTime: 0.01,
            duration: 300,
            alerts: Array.from({ length: 25 }, (_, i) => ({
              labels: { instance: `h-${i}` },
              state: 'Alerting',
              activeAt: '2026-08-26T00:00:00Z',
              value: 'v'.repeat(400),
            })),
          },
          { name: 'LowDisk', state: 'Normal', health: 'ok', alerts: [] },
          { name: 'Weird', state: 'Whatever', health: 'ok', alerts: [] },
        ],
      },
    ],
  },
}

describe('alertState', () => {
  it('flattens groups, normalizes states, and keeps unknown states visible by default', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl, { maxResponseBytes: 1_000_000 }).alertState({})
    const rules = (result.data as { rules: Record<string, unknown>[] }).rules

    expect(rules.map((rule) => rule.name)).toEqual(['HighCPU', 'Weird'])
    expect(rules[0]).toMatchObject({ group: 'cpu', folder: 'Infra', state: 'firing' })
    expect(rules[1]).toMatchObject({ state: 'unknown', stateRaw: 'Whatever' })
    expect(result.meta).toMatchObject({
      stateVocabulary: 'grafana-normalized',
      counts: { firing: 1, pending: 0, inactive: 1, unknown: 1 },
    })
  })

  it('trims annotations to the three useful keys', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl, { maxResponseBytes: 1_000_000 }).alertState({})
    const rule = (result.data as { rules: { annotations: Record<string, string> }[] }).rules[0]

    expect(Object.keys(rule?.annotations ?? {}).sort()).toEqual([
      'description',
      'runbook_url',
      'summary',
    ])
  })

  it('caps instances per rule and truncates instance values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl, { maxResponseBytes: 1_000_000 }).alertState({})
    const rule = (result.data as { rules: Record<string, unknown>[] }).rules[0]
    const instances = rule?.activeInstances as { value: string; state: string }[]

    expect(instances).toHaveLength(10)
    expect(instances[0]?.value).toHaveLength(200)
    expect(instances[0]?.state).toBe('firing')
    expect(rule).toMatchObject({ instancesTruncated: true, instancesTotal: 25 })
  })

  it('omits instances when include_instances is false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RULES_BODY))
    const result = await clientWith(fetchImpl, { maxResponseBytes: 1_000_000 }).alertState({
      includeInstances: false,
    })
    expect((result.data as { rules: Record<string, unknown>[] }).rules[0]).not.toHaveProperty(
      'activeInstances',
    )
  })

  it('truncates before paginating and reports the pre-truncation total', async () => {
    const many = {
      status: 'success',
      data: {
        groups: [
          {
            name: 'g',
            file: 'f',
            rules: Array.from({ length: 900 }, (_, i) => ({
              name: `r-${i}`,
              state: 'firing',
              alerts: [],
            })),
          },
        ],
      },
    }
    const fetchImpl = vi.fn(async () => jsonResponse(many))
    const client = clientWith(fetchImpl, { maxResponseBytes: 1_000_000 })

    const first = await client.alertState({})
    expect(first.meta).toMatchObject({ total: 900, truncated: true })
    expect(first.meta.hint).toBeTypeOf('string')

    const beyond = await client.alertState({ page: 26 })
    expect((beyond.data as { rules: unknown[] }).rules).toEqual([])
  })

  it('maps a 404 to ALERTING_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    expect((await captureError(clientWith(fetchImpl).alertState({}))).code).toBe(
      'ALERTING_UNAVAILABLE',
    )
  })

  it.each([[{ state: [] }], [{ state: ['bogus'] }], [{ maxInstancesPerRule: 51 }]])(
    'rejects invalid arguments %o',
    async (params) => {
      const fetchImpl = vi.fn()
      expect((await captureError(clientWith(fetchImpl).alertState(params))).code).toBe(
        'INVALID_INPUT',
      )
    },
  )
})

const PROVISIONED = [
  {
    uid: 'rule-1',
    title: 'HighCPU',
    folderUID: 'folder-1',
    ruleGroup: 'cpu',
    condition: 'C',
    for: '5m',
    isPaused: false,
    noDataState: 'NoData',
    execErrState: 'Error',
    labels: { severity: 'critical' },
    annotations: { summary: 's', description: 'd', runbook_url: 'r', internal: 'x' },
    data: [
      { refId: 'A', datasourceUid: 'prom-1', model: { expr: 'rate(cpu[5m])', extra: 'noise' } },
      { refId: 'C', datasourceUid: '__expr__', model: { type: 'threshold' } },
    ],
  },
]

describe('listAlertRules', () => {
  it('drops the query model unless include_query is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROVISIONED))
    const result = await clientWith(fetchImpl).listAlertRules({})
    const rule = (result.data as { rules: Record<string, unknown>[] }).rules[0]

    expect(rule).not.toHaveProperty('data')
    expect(JSON.stringify(result)).not.toContain('noise')
    expect(Object.keys((rule?.annotations ?? {}) as object).sort()).toEqual([
      'description',
      'runbook_url',
      'summary',
    ])
  })

  it('summarizes each query node when include_query is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROVISIONED))
    const result = await clientWith(fetchImpl).listAlertRules({ includeQuery: true })
    const rule = (result.data as { rules: { data: Record<string, unknown>[] }[] }).rules[0]

    expect(rule?.data).toEqual([
      { refId: 'A', datasourceUid: 'prom-1', expr: 'rate(cpu[5m])' },
      { refId: 'C', datasourceUid: '__expr__', type: 'threshold' },
    ])
  })

  it('filters by folder, group, and title before paginating', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROVISIONED))
    const client = clientWith(fetchImpl)

    await expect(client.listAlertRules({ folderUid: 'nope' })).resolves.toMatchObject({
      meta: { total: 0 },
    })
    await expect(client.listAlertRules({ titleContains: 'highcpu' })).resolves.toMatchObject({
      meta: { total: 1 },
    })
    await expect(client.listAlertRules({ ruleGroup: 'cpu' })).resolves.toMatchObject({
      meta: { total: 1 },
    })
  })

  it('accepts the top-level array shape returned by the provisioning API', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await expect(clientWith(fetchImpl).listAlertRules({})).resolves.toMatchObject({
      meta: { total: 0 },
    })
  })

  it('reports the pre-truncation total and refuses to page past the cap', async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({
      uid: `u-${i}`,
      title: `r-${i}`,
      ruleGroup: 'g',
    }))
    const fetchImpl = vi.fn(async () => jsonResponse(many))
    const client = clientWith(fetchImpl, { maxResponseBytes: 1_000_000 })

    expect((await client.listAlertRules({})).meta).toMatchObject({ total: 900, truncated: true })
    expect(
      ((await client.listAlertRules({ page: 26 })).data as { rules: unknown[] }).rules,
    ).toEqual([])
  })

  it('maps a 404 to ALERTING_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    expect((await captureError(clientWith(fetchImpl).listAlertRules({}))).code).toBe(
      'ALERTING_UNAVAILABLE',
    )
  })
})

const PROM_ERROR_BODY = {
  status: 'error',
  errorType: 'bad_data',
  error: 'parse error: unexpected end of input',
}

describe('HTTP status classification with a Prometheus-shaped error body', () => {
  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [405, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
  ])('keeps the HTTP %s classification outside the query proxy', async (status, code) => {
    const fetchImpl = vi.fn(async () => jsonResponse(PROM_ERROR_BODY, { status }))
    expect((await captureError(clientWith(fetchImpl).health())).code).toBe(code)
  })

  it('stops at NOT_FOUND when data source metadata 404s with an error body', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_ERROR_BODY, { status: 404 }),
    })
    const error = await captureError(
      clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }),
    )

    expect(error.code).toBe('NOT_FOUND')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('still maps a proxy 404 with an error body to a type error', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(PROM_ERROR_BODY, { status: 404 }),
    })
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })))
        .code,
    ).toBe('DATASOURCE_TYPE_UNSUPPORTED')
  })

  it('still maps a proxy 405 with an error body to NOT_FOUND after a degraded lookup', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => new Response('', { status: 403 }),
      '/api/v1/query': () => jsonResponse(PROM_ERROR_BODY, { status: 405 }),
    })
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })))
        .code,
    ).toBe('NOT_FOUND')
  })

  it('rate-limits a proxy 429 instead of blaming the query', async () => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(PROM_ERROR_BODY, { status: 429 }),
    })
    expect(
      (await captureError(clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' })))
        .code,
    ).toBe('RATE_LIMITED')
  })

  it.each([
    [400, 'parse error: unexpected end of input'],
    [422, undefined],
  ])('reports a proxy %s as an upstream query failure', async (status, upstreamMessage) => {
    const fetchImpl = routed({
      '/api/datasources/uid/prom-1': () => jsonResponse(PROM_META),
      '/api/v1/query': () => jsonResponse(PROM_ERROR_BODY, { status }),
    })
    const error = await captureError(
      clientWith(fetchImpl).query({ datasourceUid: 'prom-1', query: 'up' }),
    )

    expect(error.code).toBe('UPSTREAM_QUERY_FAILED')
    expect(error.errorType).toBe('bad_data')
    expect(error.upstreamMessage).toBe(upstreamMessage)
  })
})
