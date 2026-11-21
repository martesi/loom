import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { z } from 'zod'
import type { Preferences } from '../lib/preferences'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'

interface Props {
  preferences: Preferences
  storageFailed: boolean
  onChange: <Key extends keyof Preferences>(
    key: Key,
    value: Preferences[Key]
  ) => void
  sectionRef: (element: HTMLElement | null) => void
}

export function AppearanceSettings({
  preferences,
  storageFailed,
  onChange,
  sectionRef,
}: Props) {
  return (
    <section
      ref={sectionRef}
      data-section="appearance"
      aria-labelledby="settings-appearance-heading"
      className="grid scroll-mt-2 content-start gap-3"
    >
      <h3 id="settings-appearance-heading" className="text-sm font-semibold">
        <Trans>Appearance</Trans>
      </h3>
      <div className="grid gap-1 text-sm">
        <span>
          <Trans>Theme</Trans>
        </span>
        <Select
          value={preferences.theme}
          onValueChange={(value) => {
            const parsed = z.enum(['system', 'light', 'dark']).safeParse(value)
            if (parsed.success) onChange('theme', parsed.data)
          }}
        >
          <SelectTrigger
            aria-label={t`Theme`}
            className="h-10 w-full rounded border border-black/15 bg-card px-2"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">
              <Trans>System</Trans>
            </SelectItem>
            <SelectItem value="light">
              <Trans>Light</Trans>
            </SelectItem>
            <SelectItem value="dark">
              <Trans>Dark</Trans>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1 text-sm">
        <span>
          <Trans>Density</Trans>
        </span>
        <Select
          value={preferences.density}
          onValueChange={(value) => {
            const parsed = z.enum(['comfortable', 'compact']).safeParse(value)
            if (parsed.success) onChange('density', parsed.data)
          }}
        >
          <SelectTrigger
            aria-label={t`Density`}
            className="h-10 w-full rounded border border-black/15 bg-card px-2"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">
              <Trans>Comfortable</Trans>
            </SelectItem>
            <SelectItem value="compact">
              <Trans>Compact</Trans>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.showTitle}
          onChange={(event) => onChange('showTitle', event.target.checked)}
        />
        <Trans>Show titles</Trans>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.showResolution}
          onChange={(event) => onChange('showResolution', event.target.checked)}
        />
        <Trans>Show resolution</Trans>
      </label>
      {storageFailed && (
        <p role="status">
          <Trans>Changes will not be saved on this device.</Trans>
        </p>
      )}
    </section>
  )
}
