import { describe, expect, it } from 'vitest'

import {
  createHttpError,
  createUpstreamError,
  MAX_UPSTREAM_ERROR_CHARS,
  safeHeader,
} from '../src/errors.js'

const TOKEN = 'glsa_supersecret'
const BAD_DATA = { status: 'error', errorType: 'bad_data', error: 'parse error at char 5' }

describe('createHttpError', () => {
  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [405, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [418, 'GRAFANA_HTTP_ERROR'],
  ])('maps HTTP %s to %s', (status, code) => {
    expect(createHttpError(status).code).toBe(code)
  })

  it('carries Retry-After for rate limits', () => {
    expect(createHttpError(429, '30').retryAfter).toBe('30')
  })
})

describe('createUpstreamError', () => {
  it('exposes the upstream error only for HTTP 400', () => {
    expect(createUpstreamError(400, BAD_DATA, TOKEN).upstreamMessage).toBe('parse error at char 5')
    expect(createUpstreamError(422, BAD_DATA, TOKEN).upstreamMessage).toBeUndefined()
    expect(createUpstreamError(200, BAD_DATA, TOKEN).upstreamMessage).toBeUndefined()
  })

  it('always carries a whitelisted errorType and drops unknown ones', () => {
    expect(createUpstreamError(422, BAD_DATA, TOKEN).errorType).toBe('bad_data')
    expect(
      createUpstreamError(400, { ...BAD_DATA, errorType: 'weird' }, TOKEN).errorType,
    ).toBeUndefined()
  })

  it('ignores non-string and non-object bodies', () => {
    expect(createUpstreamError(400, 'plain text', TOKEN).upstreamMessage).toBeUndefined()
    expect(
      createUpstreamError(400, { ...BAD_DATA, error: { a: 1 } }, TOKEN).upstreamMessage,
    ).toBeUndefined()
  })

  it('truncates the upstream error at the character cap', () => {
    const error = 'x'.repeat(300)
    const result = createUpstreamError(400, { ...BAD_DATA, error }, TOKEN)
    expect(result.upstreamMessage).toHaveLength(MAX_UPSTREAM_ERROR_CHARS)
    expect(result.upstreamMessage?.endsWith('…')).toBe(true)
  })

  it('drops the message entirely when it contains the configured token', () => {
    const result = createUpstreamError(400, { ...BAD_DATA, error: `bad header ${TOKEN}` }, TOKEN)
    expect(result.upstreamMessage).toBeUndefined()
  })

  it.each([
    'leaked glsa_abcdefghij in query',
    'leaked glc_abcdefghij in query',
    'leaked eyJhbGciOiJIUzI1NiJ9 in query',
    'request rejected because Authorization: Bearer abcdefghij was not accepted',
  ])('redacts secret-looking fragments: %s', (error) => {
    const result = createUpstreamError(400, { ...BAD_DATA, error }, TOKEN)
    expect(result.upstreamMessage).toContain('[redacted]')
    expect(result.upstreamMessage).not.toMatch(/glsa_|glc_|eyJ/)
  })

  it('redacts the value after a bare Bearer, not just the keyword', () => {
    const result = createUpstreamError(
      400,
      {
        ...BAD_DATA,
        error: 'request rejected because Authorization: Bearer abcdefghij was not accepted',
      },
      TOKEN,
    )
    expect(result.upstreamMessage).not.toContain('abcdefghij')
  })

  it.each([
    '1:8: parse error: unexpected token "]"',
    'unknown metric secret_expiry_seconds in query',
    'expansion of api_key_total failed: no such metric',
    'invalid parameter "query": 1:5: parse error: unexpected identifier "bearer"',
    'token_bucket_refill_total has no data points',
  ])('leaves a real PromQL diagnostic intact: %s', (error) => {
    const result = createUpstreamError(400, { ...BAD_DATA, error }, TOKEN)
    expect(result.upstreamMessage).toBe(error)
  })

  it.each([
    'password=hunter2 rejected',
    'api-key = abcdefghij rejected',
    'secret: abcdefghij rejected',
  ])('still redacts a labelled credential: %s', (error) => {
    const result = createUpstreamError(400, { ...BAD_DATA, error }, TOKEN)
    expect(result.upstreamMessage).toContain('[redacted]')
  })

  it('drops the message when redaction leaves too little signal', () => {
    const result = createUpstreamError(400, { ...BAD_DATA, error: 'glsa_abcdefghij' }, TOKEN)
    expect(result.upstreamMessage).toBeUndefined()
  })

  it('never serializes the token', () => {
    const result = createUpstreamError(400, { ...BAD_DATA, error: `x ${TOKEN} y` }, TOKEN)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})

describe('toJSON', () => {
  it('exposes exactly the five documented fields', () => {
    const error = createUpstreamError(400, BAD_DATA, TOKEN)
    expect(Object.keys(error.toJSON())).toEqual([
      'code',
      'status',
      'retryAfter',
      'errorType',
      'upstreamMessage',
    ])
  })
})

describe('safeHeader', () => {
  it('rejects headers that echo the token or exceed the length cap', () => {
    const headers = new Headers({ 'x-a': TOKEN, 'x-b': 'y'.repeat(200), 'x-c': '30' })
    expect(safeHeader(headers, 'x-a', TOKEN)).toBeUndefined()
    expect(safeHeader(headers, 'x-b', TOKEN)).toBeUndefined()
    expect(safeHeader(headers, 'x-c', TOKEN)).toBe('30')
  })
})
