import { expect, test } from 'bun:test'
import { normalizePayload } from './clipboard-payload'

test('normalizes the Loom media clipboard format', () => {
  expect(
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'copy.png', data: 'YQ==' }],
      })
    )
  ).toEqual([{ name: 'copy.png', data: 'YQ==' }])
})

test('rejects unrecognized payloads and malformed media entries', () => {
  expect(() => normalizePayload('not media')).toThrow()
  expect(() =>
    normalizePayload(JSON.stringify({ version: 2, media: [] }))
  ).toThrow('Clipboard does not contain Loom media')
  expect(() =>
    normalizePayload(
      JSON.stringify({ version: 1, media: [{ name: 'bad.png' }] })
    )
  ).toThrow('Invalid Loom clipboard item')
})

test('normalizes path-like names and rejects invalid batches and encodings', () => {
  expect(
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: '../../copy.png', data: 'YQ==' }],
      })
    )
  ).toEqual([{ name: 'copy.png', data: 'YQ==' }])
  expect(() =>
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'copy.txt', data: 'YQ==' }],
      })
    )
  ).toThrow()
  expect(() =>
    normalizePayload(JSON.stringify({ version: 1, media: [] }))
  ).toThrow()
  expect(() =>
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'copy.png', data: 'not-base64' }],
      })
    )
  ).toThrow()
})

test('matches Go clipboard validation at empty-data and encoding boundaries', () => {
  for (const data of ['', 'Zh==', 'YQ', 'YQ===', 'YQ==\n']) {
    expect(() =>
      normalizePayload(
        JSON.stringify({ version: 1, media: [{ name: 'copy.png', data }] })
      )
    ).toThrow()
  }
  expect(
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'copy.png', data: 'YQ==' }],
      })
    )
  ).toEqual([{ name: 'copy.png', data: 'YQ==' }])
})

test('enforces Go clipboard item, batch, and extension boundaries', () => {
  const limit = 50 * 1024 * 1024
  const itemUnderLimit = Buffer.alloc(limit - 1).toString('base64')
  const itemAtLimit = Buffer.alloc(limit).toString('base64')
  const itemOverLimit = Buffer.alloc(limit + 1).toString('base64')
  expect(
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'under.png', data: itemUnderLimit }],
      })
    )
  ).toHaveLength(1)
  expect(
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'limit.png', data: itemAtLimit }],
      })
    )
  ).toHaveLength(1)
  expect(() =>
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: [{ name: 'large.png', data: itemOverLimit }],
      })
    )
  ).toThrow('size limit')
  expect(() =>
    normalizePayload(
      JSON.stringify({
        version: 1,
        media: Array.from({ length: 101 }, () => ({
          name: 'a.png',
          data: 'YQ==',
        })),
      })
    )
  ).toThrow('batch size')
  expect(() =>
    normalizePayload(
      JSON.stringify({ version: 1, media: [{ name: 'a.svg', data: 'YQ==' }] })
    )
  ).toThrow()
  for (const name of ['a.tif', 'a.tiff', 'a.mkv', 'a.avi']) {
    expect(
      normalizePayload(
        JSON.stringify({ version: 1, media: [{ name, data: 'YQ==' }] })
      )
    ).toHaveLength(1)
  }
})
