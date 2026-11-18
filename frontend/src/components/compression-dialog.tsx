import { t } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import {
  ImageService,
  MediaService,
  SettingsService,
} from '../../bindings/loom/internal/service'

type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png'
type CompressionMode = 'copy' | 'replace'

const settingsPrefix = 'image_tools.compress'

interface Props {
  path: string
  assetIds: number[]
  onClose: () => void
  onChange: () => Promise<void>
}

export function CompressionDialog({
  path,
  assetIds,
  onClose,
  onChange,
}: Props) {
  const [mode, setMode] = useState<CompressionMode>('copy')
  const [format, setFormat] = useState<ImageFormat>('avif')
  const [quality, setQuality] = useState(60)
  const [maxWidth, setMaxWidth] = useState('')
  const [maxHeight, setMaxHeight] = useState('')
  const [running, setRunning] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [summary, setSummary] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setSettingsLoaded(false)
    void Promise.all([
      SettingsService.Get(path, `${settingsPrefix}.mode`),
      SettingsService.Get(path, `${settingsPrefix}.format`),
      SettingsService.Get(path, `${settingsPrefix}.quality`),
      SettingsService.Get(path, `${settingsPrefix}.max_width`),
      SettingsService.Get(path, `${settingsPrefix}.max_height`),
    ])
      .then(
        ([savedMode, savedFormat, savedQuality, savedWidth, savedHeight]) => {
          if (cancelled) return
          if (savedMode === 'copy' || savedMode === 'replace')
            setMode(savedMode)
          if (isImageFormat(savedFormat)) setFormat(savedFormat)
          const parsedQuality = Number(savedQuality)
          if (parsedQuality >= 1 && parsedQuality <= 100)
            setQuality(parsedQuality)
          if (Number(savedWidth) > 0) setMaxWidth(savedWidth)
          if (Number(savedHeight) > 0) setMaxHeight(savedHeight)
        }
      )
      .catch((cause: unknown) => {
        if (cancelled) return
        console.error('compression settings load failed', cause)
        setError(
          t`Could not load saved settings. Review the defaults before compressing.`
        )
      })
      .finally(() => {
        if (!cancelled) setSettingsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  async function compress() {
    setRunning(true)
    setSummary('')
    setError('')
    let compressed = 0
    const failures: string[] = []

    try {
      await Promise.all([
        SettingsService.Set(path, `${settingsPrefix}.mode`, mode),
        SettingsService.Set(path, `${settingsPrefix}.format`, format),
        SettingsService.Set(path, `${settingsPrefix}.quality`, String(quality)),
        SettingsService.Set(path, `${settingsPrefix}.max_width`, maxWidth),
        SettingsService.Set(path, `${settingsPrefix}.max_height`, maxHeight),
      ])

      for (const id of assetIds) {
        try {
          const media = await MediaService.Transcode(path, id, {
            targetExt: format === 'jpeg' ? '.jpg' : `.${format}`,
            quality,
            maxWidth: positiveInt(maxWidth) ?? 0,
            maxHeight: positiveInt(maxHeight) ?? 0,
          })
          if (!media) throw new Error(t`Media transcode returned no result`)
          if (mode === 'replace') {
            await ImageService.ReplaceMedia(path, id, media)
          } else {
            await ImageService.ImportMedia(path, [media], false, 0, 0)
          }
          compressed++
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : String(cause))
        }
      }

      await onChange()
      setSummary(
        failures.length
          ? t`${compressed} compressed, ${failures.length} failed`
          : t`${compressed} compressed`
      )
      if (failures.length) setError(failures.join('\n'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t`Compress images`}
        className="w-full max-w-lg rounded-lg border border-black/10 bg-card p-4 shadow-xl"
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">
            <Trans>Compress images</Trans>
          </h2>
          <button
            type="button"
            aria-label={t`Close operation`}
            className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:bg-black/[0.04] disabled:opacity-40"
            disabled={running}
            onClick={onClose}
          >
            <Trans>Close</Trans>
          </button>
        </header>
        <div className="grid gap-4 text-xs text-ink">
          <p className="text-ink-muted">
            <Plural
              value={assetIds.length}
              one="# asset selected"
              other="# assets selected"
            />
          </p>
          <label className="grid gap-1">
            <span className="font-medium">
              <Trans>Result</Trans>
            </span>
            <select
              aria-label={t`Compression result`}
              disabled={!settingsLoaded || running}
              className="h-8 rounded-sm border border-black/12 bg-card px-2"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as CompressionMode)
              }
            >
              <option value="copy">
                <Trans>Create compressed copy</Trans>
              </option>
              <option value="replace">
                <Trans>Replace original</Trans>
              </option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="font-medium">
              <Trans>Format</Trans>
            </span>
            <select
              aria-label={t`Compression format`}
              disabled={!settingsLoaded || running}
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
            <span className="font-medium">
              <Trans>Quality: {quality}</Trans>
            </span>
            <input
              aria-label={t`Compression quality`}
              type="range"
              disabled={!settingsLoaded || running}
              min={1}
              max={100}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="font-medium">
                <Trans>Max width</Trans>
              </span>
              <input
                aria-label={t`Maximum width`}
                type="number"
                disabled={!settingsLoaded || running}
                min={1}
                placeholder={t`Original`}
                className="h-8 rounded-sm border border-black/12 bg-card px-2"
                value={maxWidth}
                onChange={(event) => setMaxWidth(event.target.value)}
              />
            </label>
            <label className="grid gap-1">
              <span className="font-medium">
                <Trans>Max height</Trans>
              </span>
              <input
                aria-label={t`Maximum height`}
                type="number"
                disabled={!settingsLoaded || running}
                min={1}
                placeholder={t`Original`}
                className="h-8 rounded-sm border border-black/12 bg-card px-2"
                value={maxHeight}
                onChange={(event) => setMaxHeight(event.target.value)}
              />
            </label>
          </div>
          {mode === 'replace' && (
            <p className="text-ink-muted">
              <Trans>Replacement keeps the asset ID and can be undone.</Trans>
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
            disabled={!settingsLoaded || !assetIds.length || running}
            onClick={() => void compress()}
          >
            {running ? <Trans>Compressing…</Trans> : <Trans>Compress</Trans>}
          </button>
        </div>
      </section>
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
