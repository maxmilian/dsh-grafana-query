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
