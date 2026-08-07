import { Trans } from '@lingui/react/macro'
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImageInfo, RepoInfo } from '../../bindings/loom/internal/service'
import { ImageService } from '../../bindings/loom/internal/service'
import { ImageNode, type ImageNodeData } from '../components/board/image-node'
import { Button } from '../components/ui/button'

const nodeTypes = { image: ImageNode }

interface BoardProps {
  repo: RepoInfo
}

function toNode(img: ImageInfo): Node<ImageNodeData> {
  return {
    id: String(img.id),
    type: 'image',
    position: { x: img.canvasX, y: img.canvasY },
    data: {
      fileName: img.fileName,
      promptText: img.promptText,
      thumbUrl: img.thumbUrl,
      missing: img.missing,
      archived: img.archived,
    },
  }
}

export function Board({ repo }: BoardProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ImageNodeData>>(
    []
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [images, setImages] = useState<ImageInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const loadBoard = useCallback(() => {
    ImageService.LoadBoard(repo.path).then((data) => {
      if (!data) return
      setImages(data.images ?? [])
      setNodes((data.images ?? []).map(toNode))
      setEdges(
        (data.relationships ?? []).map((rel) => ({
          id: String(rel.id),
          source: String(rel.sourceImageId),
          target: String(rel.derivedImageId),
        }))
      )
      setLoaded(true)
    })
  }, [repo.path, setNodes, setEdges])

  useEffect(() => {
    loadBoard()
  }, [loadBoard])

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      ImageService.LinkSource(
        repo.path,
        Number(connection.source),
        Number(connection.target)
      ).then(loadBoard)
    },
    [repo.path, loadBoard]
  )

  const handleNodeDragStop: OnNodeDrag<Node<ImageNodeData>> = useCallback(
    (_event, node) => {
      ImageService.SetPosition(
        repo.path,
        Number(node.id),
        node.position.x,
        node.position.y
      )
    },
    [repo.path]
  )

  const handleNodeClick: NodeMouseHandler<Node<ImageNodeData>> = useCallback(
    (_event, node) => {
      setSelectedId(node.id)
    },
    []
  )

  const selectedImage = useMemo(
    () => images.find((img) => String(img.id) === selectedId) ?? null,
    [images, selectedId]
  )

  const handleArchive = () => {
    if (!selectedImage) return
    ImageService.SetArchived(
      repo.path,
      selectedImage.id,
      !selectedImage.archived
    ).then(loadBoard)
  }

  const handleTrash = () => {
    if (!selectedImage) return
    ImageService.TrashImage(repo.path, selectedImage.id).then(() => {
      setSelectedId(null)
      loadBoard()
    })
  }

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-canvas text-ink-subtle">
        <Trans>Loading board…</Trans>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface-canvas">
      <div className="flex h-12 flex-none items-center justify-between border-b border-black/6 px-4">
        <div className="text-[13px] font-semibold text-ink">{repo.name}</div>
      </div>

      <div className="relative flex-1">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onNodeDragStop={handleNodeDragStop}
            onNodeClick={handleNodeClick}
            onPaneClick={() => setSelectedId(null)}
            defaultEdgeOptions={{
              style: { stroke: 'rgba(0,0,0,.22)', strokeWidth: 1.6 },
            }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="rgba(0,0,0,.07)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>

        {selectedImage && (
          <div className="absolute right-4 top-4 bottom-4 flex w-[280px] flex-col gap-4 rounded-lg border border-black/8 bg-card/96 p-4 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <span className="truncate text-[13px] font-semibold text-ink">
                {selectedImage.fileName}
              </span>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="text-[15px] text-ink-subtle hover:text-ink"
              >
                ×
              </button>
            </div>

            {selectedImage.missing && (
              <div className="rounded-md bg-danger-soft px-3 py-2 text-[11.5px] text-danger">
                <Trans>File not found on disk</Trans>
              </div>
            )}

            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                <Trans>Prompt</Trans>
              </div>
              <div className="rounded-md bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-muted">
                {selectedImage.promptText || <Trans>No prompt attached</Trans>}
              </div>
            </div>

            <div className="mt-auto flex flex-col gap-2">
              <Button variant="secondary" size="sm" onClick={handleArchive}>
                {selectedImage.archived ? (
                  <Trans>Unarchive</Trans>
                ) : (
                  <Trans>Archive</Trans>
                )}
              </Button>
              <Button variant="danger" size="sm" onClick={handleTrash}>
                <Trans>Trash</Trans>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
