import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type {
  CanvasData,
  ImageInfo,
} from '../../../bindings/loom/internal/service'
import type { Selection } from '../../lib/selection'
import { Button } from '../ui/button'
import { Section } from './detail-panel-section'

interface RelationshipSection {
  kind: 'sources' | 'derived'
  title: ReactNode
  relationships: NonNullable<CanvasData['relationships']>
}

interface Props {
  images: ImageInfo[]
  imageDataLoaded: boolean
  unavailableCount: number
  restoreEnabled: boolean
  onAction: (id: string) => void
  selection: Selection
  image: ImageInfo | null
  relationshipSections: readonly RelationshipSection[]
  data: CanvasData
  go: (id: number, folder?: boolean) => void
  setRemoveRelationshipId: Dispatch<SetStateAction<number | null>>
}

export function DetailPanelRelations({
  images,
  imageDataLoaded,
  unavailableCount,
  restoreEnabled,
  onAction,
  selection,
  image,
  relationshipSections,
  data,
  go,
  setRemoveRelationshipId,
}: Props) {
  return (
    <>
      <Section title={<Trans>State</Trans>}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onAction(
              images.every((image) => image.archived)
                ? 'unarchive-selection'
                : 'archive-selection'
            )
          }
        >
          {images.every((i) => i.archived) ? (
            <Trans>Unarchive</Trans>
          ) : (
            <Trans>Archive</Trans>
          )}
        </Button>
        {images.some((i) => i.trashed) && (
          <Button
            variant="secondary"
            size="sm"
            disabled={!restoreEnabled}
            onClick={() => onAction('restore-from-trash')}
          >
            <Trans>Restore from trash</Trans>
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          disabled={
            !imageDataLoaded ||
            unavailableCount > 0 ||
            images.every((item) => item.trashed)
          }
          onClick={() =>
            onAction(
              selection.surface === 'canvas'
                ? 'trash-canvas-selection'
                : 'trash-selection'
            )
          }
        >
          <Trans>Move to trash</Trans>
        </Button>
      </Section>
      {image &&
        relationshipSections.map(({ kind, title, relationships }) => (
          <Section key={kind} title={title}>
            {relationships.length === 0 && (
              <p className="text-ink-muted">
                <Trans>None</Trans>
              </p>
            )}
            {relationships.map((relationship) => {
              const endpointId =
                kind === 'sources'
                  ? relationship.sourceImageId
                  : relationship.derivedImageId
              const endpointName =
                (data.images ?? []).find((item) => item.id === endpointId)
                  ?.fileName ?? t`Asset ${endpointId}`
              return (
                <div
                  key={relationship.id}
                  className="grid gap-1.5 rounded-md border border-border p-2"
                >
                  <span className="truncate text-ink">{endpointName}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={
                      kind === 'sources'
                        ? t`Go to source asset ${endpointName}`
                        : t`Go to derived asset ${endpointName}`
                    }
                    onClick={() => go(endpointId)}
                  >
                    {kind === 'sources' ? (
                      <Trans>Go to source asset</Trans>
                    ) : (
                      <Trans>Go to derived asset</Trans>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={
                      kind === 'sources'
                        ? t`Reveal source asset ${endpointId} in Folders`
                        : t`Reveal derived asset ${endpointId} in Folders`
                    }
                    onClick={() => go(endpointId, true)}
                  >
                    <Trans>Reveal in Folders</Trans>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    aria-label={t`Remove relationship with ${endpointName}`}
                    onClick={() => setRemoveRelationshipId(relationship.id)}
                  >
                    <Trans>Remove relationship</Trans>
                  </Button>
                </div>
              )
            })}
          </Section>
        ))}
    </>
  )
}
