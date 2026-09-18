import type { Context } from '@cordisjs/core'
import type {
  AssetRef,
  CompressionRequest,
  CompressionResult,
  ImageFormat,
} from '@loom/image-tools-core'
import { useEffect, useState } from 'react'

const operationId = 'image-tools.compress'
const settingsPrefix = 'image_tools.compress'

export const imageToolsPlugin = {
  name: 'image-tools',
  inject: ['assets', 'selection', 'operations', 'media', 'settings', 'ui'],
  apply(ctx: Context) {
    ctx.operations.register({
      id: operationId,
      title: 'Compress images',
      run: (input) => runCompression(ctx, input as CompressionRequest),
    })
    ctx.ui.register('assets.itemMenu', {
      id: 'image-tools.compress-menu',
      render: () => (
        <button
          type="button"
          className="block w-full rounded-md px-3 py-2 text-left text-[12.5px] text-ink hover:bg-black/[0.04]"
          onClick={() => ctx.operations.open(operationId)}
        >
          Compress…
        </button>
      ),
    })
    ctx.ui.register('operation.workspace', {
      id: 'image-tools.compress-workspace',
      render: ({ operationId: activeId }) =>
        activeId === operationId ? <CompressionWorkspace ctx={ctx} /> : null,
    })
  },
}

async function runCompression(
  ctx: Context,
  request: CompressionRequest
): Promise<CompressionResult> {
  const outputs: CompressionResult['outputs'][number][] = []
  const failures: CompressionResult['failures'][number][] = []

  for (const source of request.assets) {
    try {
      if (typeof source.id !== 'number')
        throw new Error('Loom asset IDs must be numeric')
      const media = await ctx.media.transcode(
        source.id,
        request.policy.transform
      )
      const output =
        request.mode === 'replace'
          ? await ctx.assets.replace(source.id, media)
          : await ctx.assets.create(media)
      outputs.push({
        source,
        output: { id: output.id, name: output.fileName },
      })
    } catch (error) {
      failures.push({
        source,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { outputs, failures }
}

function CompressionWorkspace({ ctx }: { ctx: Context }) {
  const [assetIds, setAssetIds] = useState(() => [
    ...ctx.selection.current.assetIds,
  ])
  const [mode, setMode] = useState<'copy' | 'replace'>('copy')
  const [format, setFormat] = useState<ImageFormat>('avif')
  const [quality, setQuality] = useState(60)
  const [maxWidth, setMaxWidth] = useState('')
  const [maxHeight, setMaxHeight] = useState('')
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')

  useEffect(
    () =>
      ctx.selection.subscribe((selection) => {
        setAssetIds([...selection.assetIds])
      }),
    [ctx]
  )
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      ctx.settings.get(`${settingsPrefix}.mode`),
      ctx.settings.get(`${settingsPrefix}.format`),
      ctx.settings.get(`${settingsPrefix}.quality`),
      ctx.settings.get(`${settingsPrefix}.max_width`),
      ctx.settings.get(`${settingsPrefix}.max_height`),
    ]).then(
      ([savedMode, savedFormat, savedQuality, savedWidth, savedHeight]) => {
        if (cancelled) return
        if (savedMode === 'copy' || savedMode === 'replace') setMode(savedMode)
        if (isImageFormat(savedFormat)) setFormat(savedFormat)
        const parsedQuality = Number(savedQuality)
        if (parsedQuality >= 1 && parsedQuality <= 100)
          setQuality(parsedQuality)
        if (Number(savedWidth) > 0) setMaxWidth(savedWidth)
        if (Number(savedHeight) > 0) setMaxHeight(savedHeight)
      }
    )
    return () => {
      cancelled = true
    }
  }, [ctx])

  async function compress() {
    setRunning(true)
    setSummary('')
    setError('')
    try {
      const assets = (
        await Promise.all(assetIds.map((id) => ctx.assets.get(id)))
      ).filter((asset) => asset !== null)
      const refs: AssetRef[] = assets.map((asset) => ({
        id: asset.id,
        name: asset.fileName,
      }))
      const transform = {
        format,
        quality,
        maxWidth: positiveInt(maxWidth),
        maxHeight: positiveInt(maxHeight),
      }
      const request: CompressionRequest = {
        assets: refs,
        mode,
        policy: { transform },
      }
      await Promise.all([
        ctx.settings.set(`${settingsPrefix}.mode`, mode),
        ctx.settings.set(`${settingsPrefix}.format`, format),
        ctx.settings.set(`${settingsPrefix}.quality`, String(quality)),
        ctx.settings.set(`${settingsPrefix}.max_width`, maxWidth),
        ctx.settings.set(`${settingsPrefix}.max_height`, maxHeight),
      ])
      const result = (await ctx.operations.run(
        operationId,
        request
      )) as CompressionResult
      setSummary(
        `${result.outputs.length} compressed${result.failures.length ? `, ${result.failures.length} failed` : ''}`
      )
      if (result.failures.length)
        setError(result.failures.map((failure) => failure.error).join('\n'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="grid gap-4 text-xs text-ink">
      <p className="text-ink-muted">
        {assetIds.length} asset{assetIds.length === 1 ? '' : 's'} selected
      </p>
      <label className="grid gap-1">
        <span className="font-medium">Result</span>
        <select
          aria-label="Compression result"
          className="h-8 rounded-sm border border-black/12 bg-card px-2"
          value={mode}
          onChange={(event) =>
            setMode(event.target.value as 'copy' | 'replace')
          }
        >
          <option value="copy">Create compressed copy</option>
          <option value="replace">Replace original</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Format</span>
        <select
          aria-label="Compression format"
          className="h-8 rounded-sm border border-black/12 bg-card px-2"
          value={format}
          onChange={(event) => setFormat(event.target.value as ImageFormat)}
        >
          <option value="avif">AVIF</option>
          <option value="webp">WebP</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Quality: {quality}</span>
        <input
          aria-label="Compression quality"
          type="range"
          min={1}
          max={100}
          value={quality}
          onChange={(event) => setQuality(Number(event.target.value))}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1">
          <span className="font-medium">Max width</span>
          <input
            aria-label="Maximum width"
            type="number"
            min={1}
            placeholder="Original"
            className="h-8 rounded-sm border border-black/12 bg-card px-2"
            value={maxWidth}
            onChange={(event) => setMaxWidth(event.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="font-medium">Max height</span>
          <input
            aria-label="Maximum height"
            type="number"
            min={1}
            placeholder="Original"
            className="h-8 rounded-sm border border-black/12 bg-card px-2"
            value={maxHeight}
            onChange={(event) => setMaxHeight(event.target.value)}
          />
        </label>
      </div>
      {mode === 'replace' && (
        <p className="text-ink-muted">
          Replacement keeps the asset ID and can be undone.
        </p>
      )}
      {summary && <p role="status">{summary}</p>}
      {error && (
        <pre className="whitespace-pre-wrap rounded bg-danger-soft p-2 text-danger">
          {error}
        </pre>
      )}
      <button
        type="button"
        className="h-9 rounded-sm bg-primary px-3 font-semibold text-white disabled:opacity-40"
        disabled={!assetIds.length || running}
        onClick={() => void compress()}
      >
        {running ? 'Compressing…' : 'Compress'}
      </button>
    </div>
  )
}

function positiveInt(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function isImageFormat(value: string): value is ImageFormat {
  return ['avif', 'webp', 'png', 'jpeg'].includes(value)
}
