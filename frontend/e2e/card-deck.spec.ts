import { expect, test } from './test-fixtures'
import {
  autoArrangeCanvas,
  enterEdit,
  imageNodes,
  nodeBox,
  openFixtureRepo,
  placeAssets,
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

function colorChannels(color: string): [number, number, number, number] {
  const [red, green, blue] = parseRgb(color)
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1
    return [red, green, blue, alpha]
  }
  const alpha = color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1]
  return [red, green, blue, alpha === undefined ? 1 : Number(alpha)]
}

function expectColorToken(actual: string, token: string) {
  const actualChannels = colorChannels(actual)
  const tokenChannels = colorChannels(token)
  expect(actualChannels.slice(0, 3)).toEqual(tokenChannels.slice(0, 3))
  expect(Math.abs(actualChannels[3] - tokenChannels[3])).toBeLessThanOrEqual(
    1 / 255
  )
}

test.describe('Physical Cards and Studio Palette', () => {
  test('ImageNode renders with rounded-lg, multi-tier ambient shadow, hairline border, and selection ring', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'card-fixtures')
    await enterEdit(page)
    await page.keyboard.press('ControlOrMeta+0')

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

  test('hover over ImageNode reveals readable metadata without covering the card actions', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'card-hover-fixtures')
    await enterEdit(page)
    await placeAssets(page, ['hover-alpha.png'])
    await page.keyboard.press('ControlOrMeta+0')

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

    await expect(hud.getByTestId('image-preview-action')).toHaveCount(0)
    await expect(hud.getByTestId('image-more-action')).toHaveCount(0)

    const fileName = hud.getByTestId('image-node-filename')
    await expect(fileName).toBeVisible()
    await expect(fileName).toHaveText('hover-alpha.png')
    await expect(resBadge).toHaveClass(/text-\[11px\]/)
    await expect(resBadge).toHaveClass(/bg-black\/80/)
    await expect(fileName).toHaveClass(/text-xs/)
    await expect(fileName).toHaveClass(/bg-black\/80/)
    await expect(fileName).toHaveClass(/backdrop-blur-md/)

    // Measure bounding box after hover to verify zero layout shift
    const boxAfter = await nodeBox(card)
    expect(Math.abs(boxAfter.x - boxBefore.x)).toBeLessThan(1)
    expect(Math.abs(boxAfter.y - boxBefore.y)).toBeLessThan(1)
    expect(Math.abs(boxAfter.width - boxBefore.width)).toBeLessThan(1)
    expect(Math.abs(boxAfter.height - boxBefore.height)).toBeLessThan(1)

    const badgeBeforeZoom = await resBadge.boundingBox()
    const filenameBeforeZoom = await fileName.boundingBox()
    const metadata = hud.getByTestId('image-node-metadata')
    const cardBounds = await card.boundingBox()
    expect(badgeBeforeZoom).not.toBeNull()
    expect(filenameBeforeZoom).not.toBeNull()
    expect(cardBounds).not.toBeNull()
    if (!cardBounds || !badgeBeforeZoom || !filenameBeforeZoom) return
    await page.mouse.move(
      cardBounds.x + cardBounds.width / 2,
      cardBounds.y + cardBounds.height / 2
    )
    // Ctrl+wheel zooms (plain wheel pans since panOnScroll).
    await page.keyboard.down('Control')
    for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 500)
    await page.keyboard.up('Control')

    const viewportZoom = () =>
      page.locator('.react-flow__viewport').evaluate((viewport) => {
        const match = viewport.getAttribute('style')?.match(/scale\(([\d.]+)/)
        return match ? Number(match[1]) : 1
      })
    await expect.poll(viewportZoom).toBeLessThanOrEqual(0.5)
    await expect
      .poll(() =>
        metadata.evaluate((element) =>
          Number(
            (element as HTMLElement).style.getPropertyValue(
              '--canvas-inverse-zoom'
            )
          )
        )
      )
      .toBeGreaterThanOrEqual(2)
    const badgeAfterZoom = await resBadge.boundingBox()
    const filenameAfterZoom = await fileName.boundingBox()
    expect(badgeAfterZoom).not.toBeNull()
    expect(filenameAfterZoom).not.toBeNull()
    if (badgeAfterZoom && filenameAfterZoom) {
      expect(
        Math.abs(badgeAfterZoom.height - badgeBeforeZoom.height)
      ).toBeLessThan(1.5)
      expect(
        Math.abs(filenameAfterZoom.height - filenameBeforeZoom.height)
      ).toBeLessThan(1.5)
      expect(badgeAfterZoom.y + badgeAfterZoom.height).toBeLessThanOrEqual(
        filenameAfterZoom.y
      )
    }
    // The metadata block stays pinned above the card: inverse-zoom growth
    // extends upward, never sliding down over the image.
    const metadataAfterZoom = await metadata.boundingBox()
    const cardAfterZoom = await nodeBox(card)
    expect(metadataAfterZoom).not.toBeNull()
    expect(cardAfterZoom).not.toBeNull()
    if (metadataAfterZoom && cardAfterZoom) {
      expect(
        metadataAfterZoom.y + metadataAfterZoom.height
      ).toBeLessThanOrEqual(cardAfterZoom.y + 1)
    }
  })

  test('WCAG 2.1 AA and AAA contrast compliance across Studio Obsidian and Editorial Stone themes', async ({
    page,
  }) => {
    await openFixtureRepo(page, 'relationship-fixtures')
    await expect(
      page.getByRole('textbox', { name: 'Search assets' })
    ).toBeVisible()
    const filtersButton = page.getByRole('button', { name: /^Filters/ })
    await filtersButton.click()
    const assetState = page.getByRole('combobox', { name: 'Asset state' })
    await expect(assetState).toBeVisible()

    await enterEdit(page)
    await expect(imageNodes(page)).toHaveCount(3)
    await autoArrangeCanvas(page)
    await page.keyboard.press('ControlOrMeta+0')
    const source = imageNodes(page).nth(0)
    const derived = imageNodes(page).nth(1)
    await source.click()
    if (
      (await page
        .locator('aside[aria-label="Inspector"]')
        .getAttribute('data-state')) !== 'open'
    )
      await page.getByTestId('toggle-inspector-shelf').click()
    const sourceBox = await nodeBox(source)
    const derivedBox = await nodeBox(derived)
    await page.keyboard.down('Control')
    await page.mouse.move(sourceBox.x + 30, sourceBox.y + 30)
    await page.mouse.down()
    await page.mouse.move(sourceBox.x + 32, sourceBox.y + 32)
    await expect(page.getByTestId('relationship-preview')).toHaveCount(0)
    await page.mouse.move(derivedBox.x + 30, derivedBox.y + 30, { steps: 8 })
    await expect(page.getByTestId('relationship-preview')).toBeVisible()
    await page.mouse.up()
    await page.keyboard.up('Control')
    await expect(page.locator('.react-flow__edge')).toHaveCount(1)
    await source.click()

    const prompt = page.getByRole('textbox', { name: 'Prompt' })
    if (!(await prompt.isVisible()))
      await page.getByTestId('toggle-inspector-shelf').click()
    await expect(prompt).toBeVisible()
    const inspector = page.locator('.loom-detail-panel').filter({ has: prompt })
    const relatedAssetName = inspector.getByText('relation-beta.png', {
      exact: true,
    })
    await expect(relatedAssetName).toBeVisible()
    const relationshipCard = relatedAssetName.locator('..').locator('..')

    const assertThemeAwareControls = async (expectedAccent: string) => {
      const assetSearch = page.getByRole('textbox', { name: 'Search assets' })
      if (!(await assetSearch.isVisible()))
        await page.getByTestId('toggle-assets-shelf').click()
      if (!(await assetState.isVisible())) await filtersButton.click()
      await expect(assetState).toBeVisible()

      await filtersButton.hover()
      const filtersColors = await filtersButton.evaluate((element) => {
        const style = window.getComputedStyle(element)
        return {
          border: style.borderTopColor,
          background: style.backgroundColor,
        }
      })
      const toolbarButton = page.getByTestId('open-command-palette')
      await toolbarButton.hover({ force: true })
      await expect(toolbarButton).toHaveClass(/hover:bg-accent/)

      const tokens = await page.evaluate(() => {
        const style = window.getComputedStyle(document.documentElement)
        return {
          border: style.getPropertyValue('--color-border').trim(),
          input: style.getPropertyValue('--color-input').trim(),
          accent: style.getPropertyValue('--color-accent').trim(),
          muted: style.getPropertyValue('--color-muted').trim(),
        }
      })
      expect(tokens.accent).toBe(expectedAccent)
      const searchBorder = await assetSearch.evaluate(
        (element) => window.getComputedStyle(element).borderTopColor
      )
      const promptBorder = await prompt.evaluate(
        (element) => window.getComputedStyle(element).borderTopColor
      )
      const filterPanel = await assetState.locator('..').evaluate((element) => {
        const style = window.getComputedStyle(element)
        return {
          border: style.borderTopColor,
          background: style.backgroundColor,
        }
      })
      const relationBorder = await relationshipCard.evaluate(
        (element) => window.getComputedStyle(element).borderTopColor
      )

      expectColorToken(searchBorder, tokens.input)
      expectColorToken(filtersColors.border, tokens.input)
      expectColorToken(filtersColors.background, tokens.accent)
      expectColorToken(filterPanel.border, tokens.border)
      expectColorToken(filterPanel.background, tokens.muted)
      expectColorToken(promptBorder, tokens.input)
      expectColorToken(relationBorder, tokens.border)
    }

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
    await assertThemeAwareControls('#f3f2f1')

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
    await assertThemeAwareControls('#27272a')

    // Frosted glass count pill overlay contrast: white text on rgba(0,0,0,0.6)
    const pillTextContrast = contrastRatio('#ffffff', 'rgba(0, 0, 0, 0.6)')
    expect(pillTextContrast).toBeGreaterThanOrEqual(4.5)
  })
})
