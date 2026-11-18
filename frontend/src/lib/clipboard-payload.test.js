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
