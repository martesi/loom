import { useReactFlow } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'

interface TaskEntry {
  start: number
  duration: number
}

interface PerfSummary {
  tool: 'loom-perf-hud'
  userAgent: string
  viewport: { width: number; height: number }
  recordedAt: string
  durationMs: number
  zoom: number
  totalNodes: number
  mountedNodes: number
  jsHeapMB: { used: number | null; total: number | null } | null
  frames: number
  fps: number | null
  frameGapMs: {
    avg: number
    p50: number | null
    p95: number | null
    max: number
  }
  droppedFramesOver34ms: number
  longtasks: { count: number; totalMs: number; maxMs: number }
  longAnimationFrames: { count: number; totalMs: number; maxMs: number }
  frameGapsMs: number[]
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function PerfHud({ onClose }: { onClose: () => void }) {
  const flow = useReactFlow()
  const [liveFps, setLiveFps] = useState<number | null>(null)
  const [liveZoom, setLiveZoom] = useState<number | null>(null)
  const [liveHeapMB, setLiveHeapMB] = useState<number | null>(null)
  const [recording, setRecording] = useState(false)
  const [result, setResult] = useState<PerfSummary | null>(null)
  const [copied, setCopied] = useState(false)
  const recordingRef = useRef(false)
  const framesRef = useRef<number[]>([])
  const tasksRef = useRef<TaskEntry[]>([])
  const loafsRef = useRef<TaskEntry[]>([])
  const startRef = useRef(0)
  const observersRef = useRef<PerformanceObserver[]>([])

  useEffect(() => {
    let raf = 0
    let lastTick = performance.now()
    let lastUiUpdate = 0
    const gaps: number[] = []
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (recordingRef.current) framesRef.current.push(now)
      const gap = now - lastTick
      lastTick = now
      if (gap < 250) gaps.push(gap)
      if (gaps.length > 120) gaps.splice(0, gaps.length - 120)
      if (now - lastUiUpdate > 500) {
        lastUiUpdate = now
        const recent = gaps.slice(-30)
        setLiveFps(
          recent.length > 1
            ? Math.round(
                ((recent.length - 1) /
                  ((recent[recent.length - 1] - recent[0]) / 1000)) *
                  10
              ) / 10
            : null
        )
        try {
          setLiveZoom(Math.round(flow.getZoom() * 100) / 100)
        } catch {
          // Flow instance unavailable; leave the last value.
        }
        const memory = (
          performance as Performance & {
            memory?: { usedJSHeapSize: number }
          }
        ).memory
        setLiveHeapMB(
          memory ? Math.round(memory.usedJSHeapSize / 1048576) : null
        )
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [flow])

  function startRecording() {
    framesRef.current = []
    tasksRef.current = []
    loafsRef.current = []
    observersRef.current.forEach((observer) => {
      observer.disconnect()
    })
    observersRef.current = []
    const tasks = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        tasksRef.current.push({
          start: entry.startTime,
          duration: entry.duration,
        })
    })
    try {
      tasks.observe({ entryTypes: ['longtask'] })
      observersRef.current.push(tasks)
    } catch {
      tasks.disconnect()
    }
    try {
      const loafs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          loafsRef.current.push({
            start: entry.startTime,
            duration: entry.duration,
          })
      })
      loafs.observe({ entryTypes: ['long-animation-frame'] })
      observersRef.current.push(loafs)
    } catch {
      // long-animation-frame unsupported; longtasks still reported.
    }
    recordingRef.current = true
    startRef.current = performance.now()
    setResult(null)
    setCopied(false)
    setRecording(true)
  }

  function stopRecording() {
    const dragEnd = performance.now()
    const dragStart = startRef.current
    recordingRef.current = false
    observersRef.current.forEach((observer) => {
      observer.disconnect()
    })
    observersRef.current = []
    setRecording(false)
    const inWindow = (task: TaskEntry) =>
      task.start >= dragStart && task.start <= dragEnd
    const summarize = (tasks: TaskEntry[]) => {
      const windowed = tasks.filter(inWindow)
      return {
        count: windowed.length,
        totalMs:
          Math.round(windowed.reduce((sum, t) => sum + t.duration, 0) * 10) /
          10,
        maxMs:
          Math.round(Math.max(0, ...windowed.map((t) => t.duration)) * 10) / 10,
      }
    }
    const frames = framesRef.current.filter(
      (at) => at >= dragStart && at <= dragEnd
    )
    const gaps: number[] = []
    for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1])
    const sorted = [...gaps].sort((a, b) => a - b)
    const spanMs = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0
    setResult({
      tool: 'loom-perf-hud',
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      recordedAt: new Date().toISOString(),
      durationMs: Math.round((dragEnd - dragStart) * 10) / 10,
      zoom: Math.round(flow.getZoom() * 1000) / 1000,
      totalNodes: flow.getNodes().length,
      mountedNodes: document.querySelectorAll('.react-flow__node').length,
      jsHeapMB: readHeapMB(),
      frames: frames.length,
      fps:
        frames.length > 1 && spanMs > 0
          ? Math.round(((frames.length - 1) / (spanMs / 1000)) * 10) / 10
          : null,
      frameGapMs: {
        avg:
          Math.round(
            (sorted.reduce((sum, gap) => sum + gap, 0) /
              Math.max(1, sorted.length)) *
              10
          ) / 10,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: Math.round(Math.max(0, ...sorted) * 10) / 10,
      },
      droppedFramesOver34ms: sorted.filter((gap) => gap > 34).length,
      longtasks: summarize(tasksRef.current),
      longAnimationFrames: summarize(loafsRef.current),
      frameGapsMs: sorted.map((gap) => Math.round(gap * 10) / 10),
    })
  }

  function readHeapMB(): { used: number | null; total: number | null } | null {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number }
      }
    ).memory
    if (!memory) return null
    return {
      used: Math.round(memory.usedJSHeapSize / 1048576),
      total: Math.round(memory.totalJSHeapSize / 1048576),
    }
  }

  async function copyResult() {
    if (!result) return
    const text = JSON.stringify(result, null, 2)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <aside
      data-testid="perf-hud"
      aria-label="Performance HUD"
      className="absolute bottom-4 right-4 z-50 w-72 rounded-lg border border-border bg-card/95 p-3 text-xs shadow-2xl backdrop-blur-xl"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-ink">Perf HUD</span>
        <button
          type="button"
          aria-label="Close performance HUD"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-ink-muted hover:bg-black/[0.06] hover:text-ink"
        >
          ×
        </button>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums text-ink-muted">
        <span>
          live{' '}
          <strong className="text-ink">
            {liveFps === null ? '—' : `${liveFps} fps`}
          </strong>
        </span>
        <span>
          zoom{' '}
          <strong className="text-ink">
            {liveZoom === null ? '—' : liveZoom}
          </strong>
        </span>
        <span className="col-span-2">
          js heap{' '}
          <strong className="text-ink">
            {liveHeapMB === null ? '— (not Chromium)' : `${liveHeapMB} MB`}
          </strong>
        </span>
      </div>
      <p className="mb-2 leading-snug text-ink-muted">
        Record, then pan or drag on the canvas, then stop.
      </p>
      <div className="mb-2 flex gap-1.5">
        {!recording ? (
          <button
            type="button"
            onClick={startRecording}
            className="rounded-md bg-primary px-2.5 py-1 font-medium text-white hover:opacity-90"
          >
            ● Record
          </button>
        ) : (
          <button
            type="button"
            onClick={stopRecording}
            className="rounded-md bg-danger px-2.5 py-1 font-medium text-white hover:opacity-90"
          >
            ■ Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => void copyResult()}
          disabled={!result}
          className="rounded-md border border-border px-2.5 py-1 font-medium text-ink hover:bg-black/[0.06] disabled:pointer-events-none disabled:opacity-40"
        >
          {copied ? 'Copied!' : 'Copy JSON'}
        </button>
      </div>
      {recording && (
        <p className="font-medium text-danger" role="status">
          Recording… pan or drag now.
        </p>
      )}
      {result && !recording && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums text-ink-muted">
          <dt>frames</dt>
          <dd className="text-right text-ink">{result.frames}</dd>
          <dt>avg fps</dt>
          <dd className="text-right text-ink">{result.fps ?? '—'}</dd>
          <dt>p50 gap</dt>
          <dd className="text-right text-ink">
            {result.frameGapMs.p50 ?? '—'} ms
          </dd>
          <dt>p95 gap</dt>
          <dd className="text-right text-ink">
            {result.frameGapMs.p95 ?? '—'} ms
          </dd>
          <dt>max gap</dt>
          <dd className="text-right text-ink">{result.frameGapMs.max} ms</dd>
          <dt>dropped &gt;34ms</dt>
          <dd className="text-right text-ink">
            {result.droppedFramesOver34ms}
          </dd>
          <dt>longtasks</dt>
          <dd className="text-right text-ink">
            {result.longtasks.count} ({result.longtasks.totalMs} ms)
          </dd>
          <dt>nodes total/mounted</dt>
          <dd className="text-right text-ink">
            {result.totalNodes}/{result.mountedNodes}
          </dd>
          <dt>js heap used/total</dt>
          <dd className="text-right text-ink">
            {result.jsHeapMB
              ? `${result.jsHeapMB.used ?? '—'}/${result.jsHeapMB.total ?? '—'} MB`
              : 'n/a'}
          </dd>
        </dl>
      )}
    </aside>
  )
}
