import { expect, test } from 'bun:test'
import { clearObstacles } from './staging-obstacles'

test('sweeps a stack with bounded obstacle property reads', () => {
  const count = 1000
  let reads = 0
  const obstacles = Array.from(
    { length: count },
    (_, i) =>
      new Proxy(
        { id: `${i}`, x: 0, y: i * 120, width: 100, height: 60 },
        {
          get(target, property, receiver) {
            reads++
            return Reflect.get(target, property, receiver)
          },
        }
      )
  )
  const result = clearObstacles(
    { x: 0, y: 0, width: 100, height: 60 },
    obstacles,
    'down'
  )
  expect(result.y).toBe(count * 120)
  // This ordered input permits linear sorting; a repeated full scan is quadratic.
  expect(reads).toBeLessThan(count * 100)
})
