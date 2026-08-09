import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { RepoInfo } from '../../../bindings/loom/internal/service'
import { RepoService } from '../../../bindings/loom/internal/service'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { useToast } from '../ui/toast'

interface RepoSelectProps {
  repo: RepoInfo
}

// Bottom-of-panel repo select (Stage 10). Sits in FloatingPanel's reserved
// footer row, sized to leave room for Stage 11's settings gear alongside it
// — see the `w-[70%]` on the trigger below.
//
// This is modeled as a *controlled* Select whose value never actually
// changes: `value` is pinned to the current repo's path for the lifetime of
// this window. Picking a different entry fires SwitchTo (Stage 5) as a
// side-effecting action rather than a real selection — SwitchTo always
// opens/focuses a *different* window (never reuses this one, see
// repo_service.go), so this window's own repo/board view must never
// navigate as a result. Leaving `value` untouched after the call keeps the
// trigger correctly showing this window's own repo regardless of what was
// clicked.
export function RepoSelect({ repo }: RepoSelectProps) {
  const [recent, setRecent] = useState<RepoInfo[]>([])
  const toast = useToast()

  // Merge the live "current repo" (always present, always up to date) with
  // whatever the last ListRecentRepos fetch returned, so the trigger can
  // resolve a label even before the popup has ever been opened.
  const entries = useMemo(() => {
    const byPath = new Map<string, RepoInfo>()
    byPath.set(repo.path, repo)
    for (const r of recent) {
      if (!byPath.has(r.path)) byPath.set(r.path, r)
    }
    return Array.from(byPath.values())
  }, [repo, recent])

  const items = useMemo(
    () => entries.map((r) => ({ value: r.path, label: r.name || r.path })),
    [entries]
  )

  const handleOpenChange = (open: boolean) => {
    // Refresh on every open (not on every render) so "open elsewhere"
    // flags reflect windows opened/closed since the last look, without
    // hammering the backend while the panel just sits there.
    if (!open) return
    RepoService.ListRecentRepos().then((list) => setRecent(list ?? []))
  }

  const handleValueChange = (value: unknown) => {
    const path = value as string
    if (path === repo.path) return
    // SwitchTo's response only carries ID/Path when OpenedElsewhere is set
    // (see repo_service.go) — grab the friendlier name from what we
    // already loaded for the popup, before it's stale.
    const targetName = entries.find((r) => r.path === path)?.name
    RepoService.SwitchTo(path).then((result) => {
      // SwitchTo never reuses this window, so `openedElsewhere` is
      // effectively always true here — it's checked anyway to stay
      // correct if that ever changes. Either way, this window's repo
      // stays put; the toast is the only user-visible feedback that the
      // click did something.
      if (result?.openedElsewhere) {
        toast.add({
          title: t`Switched to existing window`,
          description: targetName
            ? t`Focused the window showing "${targetName}".`
            : undefined,
        })
      }
    })
  }

  return (
    <Select
      items={items}
      value={repo.path}
      onValueChange={handleValueChange}
      onOpenChange={handleOpenChange}
    >
      <SelectTrigger className="w-[70%] max-w-[70%]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {/* The current repo is shown but not offered as a selectable
            SelectItem — re-picking it would be a no-op anyway, so it's
            rendered as a plain, visually-disabled row instead (also sidesteps
            SelectItemProps not exposing a `disabled` prop, since it's typed
            off plain <div> attributes). */}
        <div className="flex min-w-[220px] cursor-default select-none items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-[12.5px] text-ink-subtle opacity-60">
          <span className="min-w-0 truncate">{repo.name || repo.path}</span>
          <span className="flex-none rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            <Trans>Current</Trans>
          </span>
        </div>
        {entries
          .filter((r) => r.path !== repo.path)
          .map((r) => (
            <SelectItem key={r.path} value={r.path} className="min-w-[220px]">
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="min-w-0 truncate">{r.name || r.path}</span>
                {r.isOpen ? (
                  <span className="flex-none rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    <Trans>Open</Trans>
                  </span>
                ) : null}
              </div>
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}
