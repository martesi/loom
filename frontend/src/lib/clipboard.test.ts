import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { getCapabilities, setCapabilities } from './capabilities-store'
import { readMedia } from './clipboard'

const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
let clipboardDescriptor: PropertyDescriptor | undefined

function textItem(text: string): ClipboardItem {
  return {
    types: ['text/plain'],
    getType: async () => new Blob([text], { type: 'text/plain' }),
  } as unknown as ClipboardItem
}

function installClipboardRead(read: () => Promise<ClipboardItem[]>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { read },
  })
}

beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  setCapabilities({ isServerMode: true })
})

afterEach(() => {
  if (clipboardDescriptor)
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  setCapabilities({ isServerMode: false })
  mock.restore()
})

it('starts browser clipboard sampling synchronously and pins the captured payload', async () => {
  let currentText = 'not Loom media'
  const read = mock(async () => {
    const capturedText = currentText
    return [textItem(capturedText)]
  })
  installClipboardRead(read)

  const pending = readMedia()
  expect(read).toHaveBeenCalledTimes(1)
  expect(getCapabilities().isServerMode).toBe(true)
  currentText = JSON.stringify({
    version: 1,
    media: [{ name: 'changed.png', data: imageData }],
  })
  await expect(pending).rejects.toThrow('Clipboard contains no media files')
})

it('returns media from the clipboard snapshot taken at invocation', async () => {
  let currentText = JSON.stringify({
    version: 1,
    media: [{ name: 'captured.png', data: imageData }],
  })
  const read = mock(async () => {
    const capturedText = currentText
    return [textItem(capturedText)]
  })
  installClipboardRead(read)

  const pending = readMedia()
  currentText = 'not Loom media'
  await expect(pending).resolves.toEqual([
    { name: 'captured.png', data: imageData },
  ])
})
