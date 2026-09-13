import { expect, test } from 'bun:test'
import { selectAsset } from './selection'

test('range and toggle selection use visible ordering', () => {
  expect(selectAsset([3], 1, [3, 2, 1], 3, true, false)).toEqual([3, 2, 1])
  expect(selectAsset([3, 2], 3, [3, 2, 1], 3, false, true)).toEqual([2])
  expect(selectAsset([3], 1, [3, 2, 1], 3, false, false)).toEqual([1])
})
