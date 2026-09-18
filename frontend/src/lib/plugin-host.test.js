import { expect, test } from 'bun:test'
import { createPluginHost } from './plugin-host'

test('plugin contributions follow Cordis lifecycle', async () => {
  const host = createPluginHost()
  let runs = 0
  const selections = []

  const fork = host.context.inject(['operations', 'ui', 'selection'], (ctx) => {
    ctx.operations.register({
      id: 'test.operation',
      title: 'Test operation',
      run: () => {
        runs += 1
      },
    })
    ctx.ui.register('assets.itemMenu', {
      id: 'test.menu',
      render: ({ assetId }) => String(assetId),
    })
    ctx.selection.subscribe((selection) => {
      selections.push([...selection.assetIds])
    })
  })

  host.setSelection({
    surface: 'assets',
    ids: [7, 9],
    edges: [],
    group: null,
  })

  expect(host.context.operations.list().map((item) => item.id)).toEqual([
    'test.operation',
  ])
  expect(host.context.ui.list('assets.itemMenu')).toHaveLength(1)
  expect(selections).toEqual([[], [7, 9]])

  await host.context.operations.run('test.operation')
  expect(runs).toBe(1)

  fork.dispose()

  expect(host.context.operations.list()).toHaveLength(0)
  expect(host.context.ui.list('assets.itemMenu')).toHaveLength(0)

  host.setSelection({
    surface: 'canvas',
    ids: [11],
    edges: [],
    group: null,
  })
  expect(selections).toEqual([[], [7, 9]])
})
