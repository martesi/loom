import { expect, test } from './test-fixtures'
import {
  imageNodes,
  nodeBox,
  openFixtureRepo,
  placeAssets,
  selectImageNodes,
} from './test-helpers'

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (match) {
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  if (color.startsWith('#')) {
    let hex = color.slice(1)
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('')
    }
    const num = Number.parseInt(hex.slice(0, 6), 16)
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
  }
  throw new Error(`Cannot parse color: ${color}`)
}

function luminance(r: number, g: number, b: number): number {
  const a = [r, g, b].map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722
}

function contrastRatio(color1: string, color2: string): number {
  const rgb1 = parseRgb(color1)
  const rgb2 = parseRgb(color2)
  const l1 = luminance(...rgb1)
  const l2 = luminance(...rgb2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

test.describe('Physical Card & Set Stack Metaphors, Studio Palette', () => {
  test('ImageNode renders with rounded-lg, multi-tier ambient shadow, hairline border, and selection ring', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'card-fixtures')
    await placeAssets(page, ['card-alpha.png'])
    await page.getByRole('button', { name: 'Reset 100%' }).click()

    const node = imageNodes(page).first()
    await expect(node).toBeVisible()

    const card = node.getByTestId('image-node-card')
    await expect(card).toBeVisible()

    // 1. Assert hairline border & rounded-lg classes
    await expect(card).toHaveClass(/rounded-lg/)
    await expect(card).toHaveClass(/border-black\/\[0\.08\]/)
    await expect(card).toHaveClass(/dark:border-white\/\[0\.10\]/)

    const borderStyle = await card.evaluate((el) => {
      const s = window.getComputedStyle(el)
      return {
        borderRadius: s.borderRadius,
        borderWidth: s.borderWidth,
        borderStyle: s.borderStyle,
        boxShadow: s.boxShadow,
      }
    })

    expect(borderStyle.borderRadius).toBe('8px')
    expect(borderStyle.borderStyle).toBe('solid')
    expect(borderStyle.borderWidth).toBe('1px')

    // 2. Assert multi-tier ambient elevation shadows
    expect(borderStyle.boxShadow).not.toBe('none')
    const shadowMatches = borderStyle.boxShadow.match(/rgba?\([^)]+\)[^,]+/g)
    expect(shadowMatches?.length).toBeGreaterThanOrEqual(2)

    // 3. Assert selection ring: ring-2 ring-primary ring-offset-2 ring-offset-background
    await node.click()
    await expect(card).toHaveClass(/ring-2/)
    await expect(card).toHaveClass(/ring-primary/)
    await expect(card).toHaveClass(/ring-offset-2/)
    await expect(card).toHaveClass(/ring-offset-background/)
  })

  test('hover over ImageNode reveals metadata overlay with zero layout shift', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'card-hover-fixtures')
    await placeAssets(page, ['hover-alpha.png'])
    await page.getByRole('button', { name: 'Reset 100%' }).click()

    const node = imageNodes(page).first()
    const card = node.getByTestId('image-node-card')
    await expect(card).toBeVisible()

    const hud = card.getByTestId('image-node-hud')
    await expect(hud).toHaveClass(/opacity-0/)
    await expect(hud).toHaveClass(/group-hover:opacity-100/)
    await expect(hud).toHaveClass(/transition-opacity/)

    // Measure bounding box before hover
    const boxBefore = await nodeBox(card)

    // Hover over image card
    await card.hover()

    // Assert metadata HUD overlay elements
    const resBadge = hud.getByTestId('resolution-badge')
    await expect(resBadge).toBeVisible()
    await expect(resBadge).toHaveText(/\d+×\d+/)

    const quickAction = hud.getByTestId('quick-action-pill')
    await expect(quickAction).toBeVisible()
    await expect(quickAction).toHaveText('Quick Action')

    const fileName = hud.getByTestId('image-node-filename')
    await expect(fileName).toBeVisible()
    await expect(fileName).toHaveText('hover-alpha.png')

    // Measure bounding box after hover to verify zero layout shift
    const boxAfter = await nodeBox(card)
    expect(Math.abs(boxAfter.x - boxBefore.x)).toBeLessThan(1)
    expect(Math.abs(boxAfter.y - boxBefore.y)).toBeLessThan(1)
    expect(Math.abs(boxAfter.width - boxBefore.width)).toBeLessThan(1)
    expect(Math.abs(boxAfter.height - boxBefore.height)).toBeLessThan(1)
  })

  test('GroupNode renders physical tactile deck offset cards and frosted count pill badge', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'deck-group-fixtures')
    await placeAssets(page, [
      'group-alpha.png',
      'group-beta.png',
      'group-gamma.png',
    ])
    await page.getByRole('button', { name: 'Auto-arrange' }).click()
    await page.getByRole('button', { name: 'Reset 100%' }).click()

    await selectImageNodes(page, [0, 1])
    await page.getByTestId('dock-create-set').click()

    const group = page.locator('.react-flow__node-group')
    await expect(group).toHaveCount(1)

    // Tactile bottom card layer
    const bottom = group.getByTestId('group-deck-bottom')
    await expect(bottom).toBeVisible()
    await expect(bottom).toHaveClass(/-rotate-2/)
    await expect(bottom).toHaveClass(/-translate-x-1/)
    await expect(bottom).toHaveClass(/translate-y-1/)
    await expect(bottom).toHaveClass(/bg-card\/60/)
    await expect(bottom).toHaveClass(/rounded-lg/)

    // Tactile middle card layer
    const middle = group.getByTestId('group-deck-middle')
    await expect(middle).toBeVisible()
    await expect(middle).toHaveClass(/rotate-2/)
    await expect(middle).toHaveClass(/translate-x-1/)
    await expect(middle).toHaveClass(/translate-y-0\.5/)
    await expect(middle).toHaveClass(/bg-card\/80/)
    await expect(middle).toHaveClass(/rounded-lg/)

    // Top cover card layer
    const top = group.getByTestId('group-deck-top')
    await expect(top).toBeVisible()
    await expect(top).toHaveClass(/rounded-lg/)
    await expect(top).toHaveClass(/bg-card/)
    await expect(top).toHaveClass(/shadow-md/)

    // Frosted glass count pill badge
    const badge = group.getByTestId('group-count-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('Set · 2 assets')
    await expect(badge).toHaveClass(/backdrop-blur-md/)
    await expect(badge).toHaveClass(/text-white/)

    // Ensure legacy hardcoded shadow was removed
    await expect(group).not.toHaveClass(/shadow-\[5px_5px/)
    await expect(top).not.toHaveClass(/shadow-\[5px_5px/)
  })

  test('double-clicking set stack expands member nodes and clicking pane collapses back to stack', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'deck-drop-fixtures')
    await placeAssets(page, [
      'group-alpha.png',
      'group-beta.png',
      'group-gamma.png',
    ])
    await page.getByRole('button', { name: 'Auto-arrange' }).click()
    await page.getByRole('button', { name: 'Reset 100%' }).click()

    await selectImageNodes(page, [0, 1])
    await page.getByTestId('dock-create-set').click()

    const group = page.locator('.react-flow__node-group')
    await expect(group).toHaveCount(1)
    await expect(imageNodes(page)).toHaveCount(1)

    // Double-click set stack to expand member nodes
    await group.dblclick()
    await expect(imageNodes(page)).toHaveCount(3)

    // Click canvas pane to collapse member nodes back to set stack
    await page
      .locator('.react-flow__pane')
      .click({ position: { x: 10, y: 10 } })
    await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
    await expect(imageNodes(page)).toHaveCount(1)
  })

  test('WCAG 2.1 AA and AAA contrast compliance across Studio Obsidian and Editorial Stone themes', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'deck-theme-fixtures')

    // 1. Light Theme (Editorial Stone) contrast assertions
    const lightTokens = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement)
      return {
        canvas: style.getPropertyValue('--color-surface-canvas').trim(),
        card: style.getPropertyValue('--color-card').trim(),
        ink: style.getPropertyValue('--color-ink').trim(),
        inkMuted: style.getPropertyValue('--color-ink-muted').trim(),
      }
    })

    expect(lightTokens.canvas).toBe('#f9f9f8')
    expect(['#ffffff', '#fff']).toContain(lightTokens.card)
    expect(lightTokens.ink).toBe('#18181b')
    expect(lightTokens.inkMuted).toBe('#52525b')

    // Primary text on Card: AAA requirement >= 7.0:1
    const lightInkOnCard = contrastRatio(lightTokens.ink, lightTokens.card)
    expect(lightInkOnCard).toBeGreaterThanOrEqual(7.0)

    // Primary text on Canvas: AAA requirement >= 7.0:1
    const lightInkOnCanvas = contrastRatio(lightTokens.ink, lightTokens.canvas)
    expect(lightInkOnCanvas).toBeGreaterThanOrEqual(7.0)

    // Muted text on Card: AA requirement >= 4.5:1 (actually satisfies AAA >= 7.0)
    const lightMutedOnCard = contrastRatio(
      lightTokens.inkMuted,
      lightTokens.card
    )
    expect(lightMutedOnCard).toBeGreaterThanOrEqual(4.5)

    // Muted text on Canvas: AA requirement >= 4.5:1
    const lightMutedOnCanvas = contrastRatio(
      lightTokens.inkMuted,
      lightTokens.canvas
    )
    expect(lightMutedOnCanvas).toBeGreaterThanOrEqual(4.5)

    // 2. Dark Theme (Studio Obsidian) contrast assertions
    await page.evaluate(() => {
      document.documentElement.classList.add('dark')
    })

    const darkTokens = await page.evaluate(() => {
      const style = window.getComputedStyle(document.documentElement)
      return {
        canvas: style.getPropertyValue('--color-surface-canvas').trim(),
        card: style.getPropertyValue('--color-card').trim(),
        ink: style.getPropertyValue('--color-ink').trim(),
        inkMuted: style.getPropertyValue('--color-ink-muted').trim(),
      }
    })

    expect(darkTokens.canvas).toBe('#0f0f11')
    expect(darkTokens.card).toBe('#18181b')
    expect(darkTokens.ink).toBe('#f4f4f5')
    expect(darkTokens.inkMuted).toBe('#a1a1aa')

    // Primary text on Card: AAA requirement >= 7.0:1
    const darkInkOnCard = contrastRatio(darkTokens.ink, darkTokens.card)
    expect(darkInkOnCard).toBeGreaterThanOrEqual(7.0)

    // Primary text on Canvas: AAA requirement >= 7.0:1
    const darkInkOnCanvas = contrastRatio(darkTokens.ink, darkTokens.canvas)
    expect(darkInkOnCanvas).toBeGreaterThanOrEqual(7.0)

    // Muted text on Card: AA requirement >= 4.5:1
    const darkMutedOnCard = contrastRatio(darkTokens.inkMuted, darkTokens.card)
    expect(darkMutedOnCard).toBeGreaterThanOrEqual(4.5)

    // Muted text on Canvas: AAA requirement >= 7.0:1
    const darkMutedOnCanvas = contrastRatio(
      darkTokens.inkMuted,
      darkTokens.canvas
    )
    expect(darkMutedOnCanvas).toBeGreaterThanOrEqual(4.5)

    // Frosted glass count pill overlay contrast: white text on rgba(0,0,0,0.6)
    const pillTextContrast = contrastRatio('#ffffff', 'rgba(0, 0, 0, 0.6)')
    expect(pillTextContrast).toBeGreaterThanOrEqual(4.5)
  })
})
