import { test, expect, type Page } from "@playwright/test"

// A minimal display-settings stub. The node render reads a couple of these
// non-optionally, so the object must exist; missing keys read as falsy.
const displaySettings = {}

function makeNode(id: string, label: string, x: number, y: number) {
  return {
    id,
    type: "customNode",
    position: { x, y },
    data: {
      label,
      type: "web-server",
      criticality: "Low",
      services: [],
      actions: [],
      displaySettings,
      isCompromised: false,
      investigationStatus: "No Status",
    },
  }
}

// Two nodes far apart with one edge between them.
const seed = {
  version: "1.0",
  nodes: [makeNode("n1", "Alpha", 0, 0), makeNode("n2", "Beta", 600, 40)],
  edges: [
    {
      id: "e1",
      source: "n1",
      target: "n2",
      type: "customEdge",
      data: {
        actionType: "Lateral Movement",
        toolUsed: "",
        userUsed: "",
        timestamp: "2025-01-01T12:00:00.000Z",
        description: "",
        displaySettings: {},
      },
    },
  ],
  canvasTitle: "Test Diagram",
  incidentLog: [],
  viewport: { x: 100, y: 200, zoom: 1 },
  timestamp: new Date().toISOString(),
}

async function seedDiagram(page: Page, snapshot = seed) {
  await page.addInitScript((snapshot) => {
    localStorage.setItem("compromise-canvas-autosave-enabled", "true")
    localStorage.setItem("compromise-canvas-autosave-flow", JSON.stringify(snapshot))
    localStorage.setItem("compromise-canvas-autosave-timestamp", snapshot.timestamp)
  }, snapshot)
  await page.goto("/")
  // Wait for the seeded edge to render.
  await page.locator(".react-flow__edge").first().waitFor()
}

// The visible edge path element (React Flow renders one per edge).
const edgePath = (page: Page) => page.locator(".react-flow__edge-path").first()

test("edge is locked by default and cannot be rerouted by dragging", async ({ page }) => {
  await seedDiagram(page)
  const path = edgePath(page)
  const before = await path.getAttribute("d")

  // Drag across the middle of the canvas where the edge sits.
  const box = await page.locator(".react-flow__viewport").boundingBox()
  expect(box).not.toBeNull()
  const midX = box!.x + box!.width / 2
  const midY = box!.y + box!.height / 2
  await page.mouse.move(midX, midY)
  await page.mouse.down()
  await page.mouse.move(midX + 120, midY - 90, { steps: 8 })
  await page.mouse.up()

  // Locked edge keeps its smoothstep geometry (no bend committed).
  await expect(path).toHaveAttribute("d", before ?? "")
})

test("unlock toggle enables rerouting; drag bends the edge and moves its label", async ({ page }) => {
  await seedDiagram(page)
  const path = edgePath(page)
  // The label card (distinct from the toolbar, which also lives in the edge-label
  // renderer) is the one carrying the edge's action-type text.
  const label = page
    .locator(".react-flow__edgelabel-renderer > div")
    .filter({ hasText: "Lateral Movement" })

  // Hover the label card (sits on the edge midpoint) to reveal the toolbar.
  await label.hover()

  const unlockBtn = page.getByRole("button", { name: "Unlock edge to move it" })
  await expect(unlockBtn).toBeVisible()

  const pathLocked = await path.getAttribute("d")

  // Unlock: the button flips to a "Lock edge" affordance (state persisted).
  await unlockBtn.click()
  await expect(page.getByRole("button", { name: "Lock edge" })).toBeVisible()

  // Unlocking alone swaps the smoothstep route for a (still straight) quadratic
  // one; this is the geometry a single undo of the drag should restore.
  const pathUnlocked = await path.getAttribute("d")
  expect(pathUnlocked).not.toEqual(pathLocked)
  expect(pathUnlocked).toContain("Q")
  const labelUnlocked = await label.getAttribute("style")

  // Drag the label card to bend the edge through a control point.
  const lb = await label.boundingBox()
  const cx = lb!.x + lb!.width / 2
  const cy = lb!.y + lb!.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 120, cy - 90, { steps: 10 })
  await page.mouse.up()

  // Drag bent the edge: the quadratic control point (and thus the path) moved.
  const pathAfter = await path.getAttribute("d")
  expect(pathAfter).not.toEqual(pathUnlocked)
  expect(pathAfter).toContain("Q")

  // Label card followed the bend.
  const labelAfter = await label.getAttribute("style")
  expect(labelAfter).not.toEqual(labelUnlocked)

  // Undo restores the pre-drag (unlocked, straight) geometry.
  await page.keyboard.press("Control+z")
  await expect(path).toHaveAttribute("d", pathUnlocked ?? "")
})

test("toolbar edge changes remain intact after a properties edit", async ({ page }) => {
  await seedDiagram(page)
  const label = page
    .locator(".react-flow__edgelabel-renderer > div")
    .filter({ hasText: "Lateral Movement" })

  await page.getByRole("button", { name: "Open Timeline" }).click()
  await page.getByRole("button").filter({ hasText: "Alpha" }).filter({ hasText: "Beta" }).click()
  await page.keyboard.press("Escape")
  const edgeLabelInput = page.getByRole("textbox").first()
  await expect(edgeLabelInput).toBeVisible()

  await page.getByRole("button", { name: "Unlock edge to move it" }).click()
  await page.getByRole("button", { name: "Change action type" }).click()
  await page.getByRole("menuitem", { name: "Impact" }).click()
  await edgeLabelInput.fill("Preserved change")

  await expect(page.getByRole("button", { name: "Lock edge" })).toBeVisible()
  await expect(page.locator(".react-flow__edgelabel-renderer").getByText("Impact", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Save to browser storage" }).click()
  const savedEdgeData = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("compromise-canvas-flow") || "{}")
    return saved.edges[0].data
  })
  expect(savedEdgeData).toMatchObject({
    unlocked: true,
    actionType: "Impact",
    label: "Preserved change",
  })
})

test("dragging one selected unlocked edge moves every selected unlocked route atomically", async ({ page }) => {
  const snapshot = {
    ...seed,
    nodes: [
      makeNode("n1", "Alpha", 0, 100),
      makeNode("n2", "Beta", 650, -120),
      makeNode("n3", "Gamma", 650, 360),
    ],
    edges: [
      {
        ...seed.edges[0],
        id: "e1",
        selected: true,
        data: { ...seed.edges[0].data, unlocked: true, labelOffsetX: 10, labelOffsetY: 5 },
      },
      {
        ...seed.edges[0],
        id: "e2",
        target: "n3",
        selected: true,
        data: {
          ...seed.edges[0].data,
          actionType: "Impact",
          unlocked: true,
          labelOffsetX: -20,
          labelOffsetY: 30,
        },
      },
    ],
  }
  await seedDiagram(page, snapshot)

  const edge = (id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`)
  await expect(edge("e1")).toHaveClass(/selected/)
  await expect(edge("e2")).toHaveClass(/selected/)

  const activeLabel = page
    .locator(".react-flow__edgelabel-renderer > div")
    .filter({ hasText: "Lateral Movement" })
  const secondPath = edge("e2").locator(".react-flow__edge-path")
  const secondPathBefore = await secondPath.getAttribute("d")
  const labelBox = await activeLabel.boundingBox()
  expect(labelBox).not.toBeNull()

  const startX = labelBox!.x + labelBox!.width / 2
  const startY = labelBox!.y + labelBox!.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 100, startY - 60, { steps: 8 })
  await expect(secondPath).not.toHaveAttribute("d", secondPathBefore ?? "")
  await page.mouse.up()

  await page.getByRole("button", { name: "Save to browser storage" }).click()
  let savedEdges = await page.evaluate(() => JSON.parse(localStorage.getItem("compromise-canvas-flow") || "{}").edges)
  let byId = new Map<string, { data: { labelOffsetX: number; labelOffsetY: number } }>(
    savedEdges.map((item: { id: string }) => [item.id, item]),
  )
  expect(byId.get("e1")?.data.labelOffsetX).toBeCloseTo(110, 5)
  expect(byId.get("e1")?.data.labelOffsetY).toBeCloseTo(-55, 5)
  expect(byId.get("e2")?.data.labelOffsetX).toBeCloseTo(80, 5)
  expect(byId.get("e2")?.data.labelOffsetY).toBeCloseTo(-30, 5)

  await page.keyboard.press("Control+z")
  await page.getByRole("button", { name: "Save to browser storage" }).click()
  savedEdges = await page.evaluate(() => JSON.parse(localStorage.getItem("compromise-canvas-flow") || "{}").edges)
  byId = new Map(savedEdges.map((item: { id: string }) => [item.id, item]))
  expect(byId.get("e1")?.data.labelOffsetX).toBe(10)
  expect(byId.get("e1")?.data.labelOffsetY).toBe(5)
  expect(byId.get("e2")?.data.labelOffsetX).toBe(-20)
  expect(byId.get("e2")?.data.labelOffsetY).toBe(30)
})
