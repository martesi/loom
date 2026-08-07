import { Trans } from '@lingui/react/macro'
import { Button } from '../components/ui/button'

export interface RecentRepo {
  id: string
  name: string
  path: string
  imageCount: number
  openedAt: string
}

interface LandingProps {
  recentRepos: RecentRepo[]
  onOpenFolder: () => void
  onCreateRepo: () => void
  onSelectRepo: (repo: RecentRepo) => void
}

export function Landing({
  recentRepos,
  onOpenFolder,
  onCreateRepo,
  onSelectRepo,
}: LandingProps) {
  if (recentRepos.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <div className="flex w-[420px] flex-col items-center gap-5 rounded-lg border border-black/8 bg-card p-10 shadow-lg">
          <div className="relative h-14 w-14 rounded-[12px] bg-accent">
            <div className="absolute left-[10px] top-[14px] h-[18px] w-[18px] rounded-full border-[3px] border-white" />
            <div className="absolute left-[28px] top-[24px] h-[18px] w-[18px] rounded-full border-[3px] border-white/55" />
          </div>
          <h1 className="text-xl font-semibold text-ink">
            <Trans>Welcome to Loom</Trans>
          </h1>
          <p className="max-w-[340px] text-center text-[13px] leading-relaxed text-ink-muted">
            <Trans>
              Loom keeps every derived-image relationship on a canvas that stays
              fast — even at thousands of images.
            </Trans>
          </p>
          <div className="mt-2 flex gap-2.5">
            <Button variant="primary" onClick={onOpenFolder}>
              <Trans>Open Folder</Trans>
            </Button>
            <Button variant="secondary" onClick={onCreateRepo}>
              <Trans>Create New Repo</Trans>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-black/6 px-7 py-5">
        <div className="flex items-center gap-2.5">
          <div className="h-[26px] w-[26px] rounded-[7px] bg-accent" />
          <span className="text-[15px] font-semibold text-ink">
            <Trans>Loom</Trans>
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onOpenFolder}>
            <Trans>Open Folder</Trans>
          </Button>
          <Button variant="primary" size="sm" onClick={onCreateRepo}>
            <Trans>New Repo</Trans>
          </Button>
        </div>
      </div>

      <div className="px-7 pt-5 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        <Trans>Recent</Trans>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-5 py-2">
        {recentRepos.map((repo) => (
          <button
            type="button"
            key={repo.id}
            onClick={() => onSelectRepo(repo)}
            className="flex items-center gap-3.5 rounded-md px-3 py-3.5 text-left hover:bg-black/[0.03]"
          >
            <div className="h-[38px] w-[38px] flex-none rounded-[7px] border border-black/6 bg-surface" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold text-ink">
                {repo.name}
              </div>
              <div className="truncate text-[11.5px] text-ink-subtle">
                {repo.path}
              </div>
            </div>
            <div className="flex-none text-[11.5px] text-ink-subtle">
              <Trans>{repo.imageCount} images</Trans>
            </div>
            <div className="w-[130px] flex-none text-right text-[11.5px] text-ink-subtle">
              {repo.openedAt}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
