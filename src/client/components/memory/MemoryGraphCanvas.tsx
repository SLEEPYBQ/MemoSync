// The memory map: a force layout drawn to a canvas so hundreds of nodes stay
// smooth at any zoom. It blooms out of the centre once, then holds still.
import { Maximize2, Minus, Plus } from "lucide-react"
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { memoryGraphStructureKey, MEMORY_GRAPH_ROOT_ID, type MemoryGraphEdge, type MemoryGraphNode } from "../../lib/memoryGraph"
import type { MemoryScope } from "../../lib/memoriesApi"
import { cn } from "../../lib/utils"

type SimNode = MemoryGraphNode & SimulationNodeDatum & { x: number; y: number }
type SimEdge = Omit<MemoryGraphEdge, "source" | "target"> & SimulationLinkDatum<SimNode> & { source: SimNode | string; target: SimNode | string }

const SCOPE_COLORS: Record<MemoryScope, string> = { personal: "#d97757", project: "#6a9bcc", session: "#8fa86d" }
const CANDIDATE_COLOR = "#e0a33a"

/** The map sits on the page's own surface, so it belongs to whichever theme is on. */
const CANVAS_THEMES = {
  light: { background: "#fbfaf7", ink: "38, 33, 28", root: "#2b2723", selection: "#2b2723", edge: 0.17, edgeLit: 0.45, hubLabel: 0.82, memoryLabel: 0.58 },
  dark: { background: "#1b1a18", ink: "245, 242, 236", root: "#f5f2ec", selection: "#ffffff", edge: 0.15, edgeLit: 0.42, hubLabel: 0.86, memoryLabel: 0.55 },
}

function currentCanvasTheme() {
  return CANVAS_THEMES[document.documentElement.classList.contains("dark") ? "dark" : "light"]
}
const MIN_ZOOM = 0.25
const MAX_ZOOM = 5
const LABEL_FONT = '11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif'

/** Stable topic hues keep a group recognizable after renames and refreshes. */
function topicHue(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return [12, 35, 70, 145, 185, 215, 265, 310][hash % 8]
}

function nodeColor(node: MemoryGraphNode, rootColor: string): string {
  if (node.kind === "root") return "#e7a139"
  if (node.id === "topic:unclassified") return "#8b79c9"
  if (node.kind === "hub" && node.id.startsWith("topic:")) return `hsl(${topicHue(node.id.slice(6))} 64% 47%)`
  if (node.kind === "memory") {
    if (!node.item?.topicId) return "#7cb7bf"
    return `hsl(${topicHue(node.item.topicId)} 67% 72%)`
  }
  return node.scope ? SCOPE_COLORS[node.scope] : rootColor
}

function clipLabel(label: string, max: number): string {
  const characters = [...label]
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : label
}

export interface MemoryGraphLegendEntry {
  key: string
  label: string
  color: string
  hollow?: boolean
}

export const memoryGraphLegend = (labels: { personal: string; project: string; session: string; candidate: string }): MemoryGraphLegendEntry[] => [
  { key: "personal", label: labels.personal, color: SCOPE_COLORS.personal },
  { key: "project", label: labels.project, color: SCOPE_COLORS.project },
  { key: "session", label: labels.session, color: SCOPE_COLORS.session },
  { key: "candidate", label: labels.candidate, color: CANDIDATE_COLOR, hollow: true },
]

interface Props {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  /** Memory or hub ids to keep lit; null lights everything. */
  highlight: Set<string> | null
  selectedId: string | null
  onSelectMemory: (id: string) => void
  onSelectNode?: (id: string) => void
  focusKey?: string
  onHoverMemory?: (id: string) => void
  legend: MemoryGraphLegendEntry[]
  ariaLabel: string
  zoomInLabel: string
  zoomOutLabel: string
  fitLabel: string
  emptyHint?: string
}

export function MemoryGraphCanvas({
  nodes,
  edges,
  highlight,
  selectedId,
  onSelectMemory,
  onSelectNode,
  focusKey,
  onHoverMemory,
  legend,
  ariaLabel,
  zoomInLabel,
  zoomOutLabel,
  fitLabel,
  emptyHint,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const simulationRef = useRef<Simulation<SimNode, SimEdge> | null>(null)
  const simNodesRef = useRef<SimNode[]>([])
  const simEdgesRef = useRef<SimEdge[]>([])
  const positionsRef = useRef(new Map<string, { x: number; y: number; vx?: number; vy?: number }>())
  const viewRef = useRef({ x: 0, y: 0, k: 1 })
  const sizeRef = useRef({ width: 0, height: 0 })
  /** Until the person pans or zooms, the view keeps framing the whole map. */
  const autoFitRef = useRef(true)
  const hoverRef = useRef<SimNode | null>(null)
  const frameRef = useRef<number | null>(null)
  const propsRef = useRef({ highlight, selectedId })
  propsRef.current = { highlight, selectedId }
  const [tooltip, setTooltip] = useState<{ node: MemoryGraphNode; x: number; y: number } | null>(null)

  const structureKey = useMemo(() => memoryGraphStructureKey({ nodes, edges }), [nodes, edges])
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  const targetView = useCallback(() => {
    const { width, height } = sizeRef.current
    const simNodes = simNodesRef.current
    if (!width || !height || simNodes.length === 0) return { x: width / 2, y: height / 2, k: 1 }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const node of simNodes) {
      minX = Math.min(minX, node.x - node.radius)
      maxX = Math.max(maxX, node.x + node.radius)
      minY = Math.min(minY, node.y - node.radius)
      maxY = Math.max(maxY, node.y + node.radius)
    }
    const padding = 72
    const k = Math.min(2.2, Math.max(MIN_ZOOM, Math.min(
      (width - padding * 2) / Math.max(1, maxX - minX),
      (height - padding * 2) / Math.max(1, maxY - minY),
    )))
    const root = simNodes.find(node => node.id === MEMORY_GRAPH_ROOT_ID)
    if (focusKey === "all" && root) {
      const centeredZoom = Math.min(k, (width / 2 - padding) / Math.max(1, root.x - minX, maxX - root.x), (height / 2 - padding) / Math.max(1, root.y - minY, maxY - root.y))
      const zoom = Math.max(MIN_ZOOM, centeredZoom)
      const largeZoom = Math.min(MAX_ZOOM, zoom * 1.4)
      return { x: width / 2 - root.x * largeZoom, y: height / 2 - root.y * largeZoom, k: largeZoom }
    }
    return { x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k, k }
  }, [focusKey])

  const draw = useCallback(() => {
    frameRef.current = null
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    const { width, height } = sizeRef.current
    const dpr = window.devicePixelRatio || 1
    const view = viewRef.current
    const theme = currentCanvasTheme()
    const simulationActive = (simulationRef.current?.alpha() ?? 0) > (simulationRef.current?.alphaMin() ?? 0)

    let framing = false
    if (autoFitRef.current) {
      const target = targetView()
      const ease = 0.14
      view.x += (target.x - view.x) * ease
      view.y += (target.y - view.y) * ease
      view.k += (target.k - view.k) * ease
      framing = Math.abs(target.x - view.x) > 0.4 || Math.abs(target.y - view.y) > 0.4 || Math.abs(target.k - view.k) > 0.002
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = theme.background
    context.fillRect(0, 0, width, height)
    context.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y)

    const { highlight: lit, selectedId: selected } = propsRef.current
    const hover = hoverRef.current
    const neighbours = hover ? new Set<string>([hover.id]) : null
    if (hover && neighbours) {
      for (const edge of simEdgesRef.current) {
        const source = edge.source as SimNode
        const target = edge.target as SimNode
        if (source.id === hover.id) neighbours.add(target.id)
        if (target.id === hover.id) neighbours.add(source.id)
      }
    }
    const lightOf = (node: SimNode) => {
      if (neighbours) return neighbours.has(node.id) ? 1 : 0.16
      if (lit) return lit.has(node.id) || node.id === MEMORY_GRAPH_ROOT_ID ? 1 : 0.14
      return 1
    }

    for (const edge of simEdgesRef.current) {
      const source = edge.source as SimNode
      const target = edge.target as SimNode
      const light = Math.min(lightOf(source), lightOf(target))
      context.beginPath()
      context.moveTo(source.x, source.y)
      context.lineTo(target.x, target.y)
      if (edge.kind === "relation") {
        context.setLineDash([3, 3])
        context.strokeStyle = `rgba(224, 163, 58, ${0.6 * light})`
        context.lineWidth = 1 / Math.sqrt(view.k)
      } else {
        context.setLineDash([])
        context.strokeStyle = `rgba(${theme.ink}, ${(neighbours && light === 1 ? theme.edgeLit : theme.edge) * light})`
        context.lineWidth = 0.8 / Math.sqrt(view.k)
      }
      context.stroke()
    }
    context.setLineDash([])

    for (const node of simNodesRef.current) {
      const light = lightOf(node)
      const color = nodeColor(node, theme.root)
      const isSelected = node.item?.id === selected && Boolean(selected)
      context.globalAlpha = light
      // A faint halo, so nodes glow against the dark rather than sit on it.
      context.beginPath()
      context.arc(node.x, node.y, node.radius + (isSelected ? 7 : node.kind === "memory" ? 2 : 5), 0, Math.PI * 2)
      context.fillStyle = color
      context.globalAlpha = light * (isSelected ? 0.3 : 0.12)
      context.fill()
      context.globalAlpha = light
      context.beginPath()
      context.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
      if (node.candidate) {
        context.fillStyle = theme.background
        context.fill()
        context.lineWidth = 1.5
        context.strokeStyle = color
        context.stroke()
      } else {
        const sphere = context.createRadialGradient(
          node.x - node.radius * 0.38, node.y - node.radius * 0.42, node.radius * 0.06,
          node.x + node.radius * 0.12, node.y + node.radius * 0.16, node.radius * 1.18,
        )
        sphere.addColorStop(0, node.kind === "root" ? "#f7bd57" : "#ffffff")
        sphere.addColorStop(0.24, color)
        sphere.addColorStop(1, color)
        context.shadowColor = color
        context.shadowBlur = node.kind === "memory" ? 8 : 16
        context.fillStyle = sphere
        context.fill()
        context.shadowBlur = 0
        context.beginPath()
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
        context.strokeStyle = "rgba(20, 25, 35, 0.22)"
        context.lineWidth = 1
        context.stroke()
      }
      if (isSelected || node === hover) {
        context.beginPath()
        context.arc(node.x, node.y, node.radius + 2.5, 0, Math.PI * 2)
        context.lineWidth = 1.25 / Math.sqrt(view.k)
        context.strokeStyle = theme.selection
        context.stroke()
      }
    }
    context.globalAlpha = 1

    // Text in screen space, so it stays the same size at every zoom.
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.font = LABEL_FONT
    context.textAlign = "center"
    context.textBaseline = "top"
    for (const node of simNodesRef.current) {
      const light = lightOf(node)
      const isHub = node.kind !== "memory"
      const showMemoryLabel = !isHub && (view.k >= 1.7 || (neighbours?.has(node.id) ?? false)) && node !== hover
      if ((!isHub && !showMemoryLabel) || light < 0.5) continue
      const label = clipLabel(node.label, isHub ? 22 : 16)
      context.fillStyle = `rgba(${theme.ink}, ${isHub ? theme.hubLabel : theme.memoryLabel})`
      context.fillText(label, node.x * view.k + view.x, (node.y + node.radius) * view.k + view.y + 5)
    }

    if (simulationActive || framing) requestDraw()
  }, [targetView]) // eslint-disable-line react-hooks/exhaustive-deps

  const requestDraw = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw)
  }, [draw])

  // Rebuild the layout only when the shape of the map changes; surviving nodes keep their place.
  useEffect(() => {
    simulationRef.current?.stop()
    const previous = positionsRef.current
    const isFirst = previous.size === 0
    const simNodes: SimNode[] = nodesRef.current.map((node, index) => {
      const known = previous.get(node.id)
      const angle = index * 2.399963 // golden angle, so the bloom starts evenly.
      return { ...node, x: known?.x ?? Math.cos(angle) * (4 + index * 0.4), y: known?.y ?? Math.sin(angle) * (4 + index * 0.4), vx: known?.vx ?? 0, vy: known?.vy ?? 0 }
    })
    const simEdges: SimEdge[] = edgesRef.current.map((edge) => ({ ...edge }))
    simNodesRef.current = simNodes
    simEdgesRef.current = simEdges
    hoverRef.current = null

    const simulation = forceSimulation<SimNode, SimEdge>(simNodes)
      .force("link", forceLink<SimNode, SimEdge>(simEdges)
        .id((node) => node.id)
        .distance((edge) => {
          if (edge.kind === "relation") return 52
          const target = edge.target as SimNode
          return target.kind === "memory" ? 55 + target.radius * 2 : 180
        })
        .strength((edge) => (edge.kind === "relation" ? 0.1 : 0.85)))
      .force("charge", forceManyBody<SimNode>().strength((node) => (node.kind === "memory" ? -70 : -850)))
      .force("collide", forceCollide<SimNode>().radius((node) => node.radius + 3))
      .force("x", forceX<SimNode>(0).strength(0.02))
      .force("y", forceY<SimNode>(0).strength(0.02))
      .alpha(isFirst ? 1 : 0.5)
      .alphaDecay(0.03)
      .on("tick", () => {
        for (const node of simNodes) positionsRef.current.set(node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy })
        requestDraw()
      })
    simulationRef.current = simulation

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      simulation.stop()
      simulation.tick(300)
      for (const node of simNodes) positionsRef.current.set(node.id, { x: node.x, y: node.y })
      autoFitRef.current = true
    } else if (isFirst) {
      // Untangle before the first paint, so it opens as a settling map rather than a knot.
      simulation.tick(70)
      viewRef.current = targetView()
    }
    requestDraw()
    return () => {
      simulation.stop()
    }
  }, [structureKey, requestDraw, targetView])

  useEffect(() => {
    autoFitRef.current = true
    requestDraw()
  }, [focusKey, requestDraw])

  // Fresh data on the same shape (usage counts, new text) needs no new layout.
  useEffect(() => {
    const fresh = new Map(nodes.map((node) => [node.id, node]))
    for (const simNode of simNodesRef.current) {
      const node = fresh.get(simNode.id)
      if (node) Object.assign(simNode, { label: node.label, radius: node.radius, item: node.item, candidate: node.candidate })
    }
    requestDraw()
  }, [nodes, requestDraw])

  useEffect(() => {
    requestDraw()
  }, [highlight, selectedId, requestDraw])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    let firstMeasure = true
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width, height }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      // The layout usually finishes before the first measure: open already framed.
      if (firstMeasure && autoFitRef.current) viewRef.current = targetView()
      firstMeasure = false
      draw()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw, targetView])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  // Canvas pixels don't follow CSS: repaint when the theme class flips.
  useEffect(() => {
    const observer = new MutationObserver(requestDraw)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [requestDraw])

  const nodeAt = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    const view = viewRef.current
    const x = (clientX - rect.left - view.x) / view.k
    const y = (clientY - rect.top - view.y) / view.k
    let best: SimNode | null = null
    let bestDistance = Infinity
    for (const node of simNodesRef.current) {
      const distance = Math.hypot(node.x - x, node.y - y)
      // A forgiving target: small dots are hard to land on.
      const reach = node.radius + 5 / view.k
      if (distance <= reach && distance < bestDistance) {
        best = node
        bestDistance = distance
      }
    }
    return best
  }, [])

  const zoomBy = useCallback((factor: number, originX?: number, originY?: number) => {
    autoFitRef.current = false
    const view = viewRef.current
    const { width, height } = sizeRef.current
    const px = originX ?? width / 2
    const py = originY ?? height / 2
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor))
    view.x = px - ((px - view.x) / view.k) * k
    view.y = py - ((py - view.y) / view.k) * k
    view.k = k
    requestDraw()
  }, [requestDraw])

  // React's onWheel is passive, and this one has to keep the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomBy(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX - rect.left, event.clientY - rect.top)
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [zoomBy])

  const lastPointerMovedRef = useRef(false)
  const dragRef = useRef<{ kind: "pan" | "node"; node?: SimNode; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null>(null)

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    lastPointerMovedRef.current = false
    const node = nodeAt(event.clientX, event.clientY)
    dragRef.current = { kind: node ? "node" : "pan", node: node ?? undefined, startX: event.clientX, startY: event.clientY, moved: false, viewX: viewRef.current.x, viewY: viewRef.current.y }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const canvas = event.currentTarget
    if (drag) {
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      drag.moved = true
      setTooltip(null)
      if (drag.kind === "pan") {
        autoFitRef.current = false
        viewRef.current.x = drag.viewX + dx
        viewRef.current.y = drag.viewY + dy
        canvas.style.cursor = "grabbing"
        requestDraw()
      } else if (drag.node) {
        const rect = canvas.getBoundingClientRect()
        const view = viewRef.current
        autoFitRef.current = false
        drag.node.fx = (event.clientX - rect.left - view.x) / view.k
        drag.node.fy = (event.clientY - rect.top - view.y) / view.k
        simulationRef.current?.alphaTarget(0.15).restart()
      }
      return
    }
    const node = nodeAt(event.clientX, event.clientY)
    if (node !== hoverRef.current) {
      hoverRef.current = node
      canvas.style.cursor = node ? (node.kind === "memory" ? "pointer" : "grab") : "grab"
      if (node?.item) onHoverMemory?.(node.item.id)
      requestDraw()
    }
    if (node) {
      const rect = canvas.getBoundingClientRect()
      setTooltip({ node, x: event.clientX - rect.left, y: event.clientY - rect.top })
    } else {
      setTooltip(null)
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    event.currentTarget.style.cursor = "grab"
    if (drag.node && drag.moved) {
      drag.node.fx = null
      drag.node.fy = null
      simulationRef.current?.alphaTarget(0)
    }
    lastPointerMovedRef.current = drag.moved
  }

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (lastPointerMovedRef.current) return
    const node = nodeAt(event.clientX, event.clientY)
    if (node?.item) onSelectMemory(node.item.id)
    else if (node) onSelectNode?.(node.id)
  }

  const handleFit = () => {
    autoFitRef.current = true
    viewRef.current = targetView()
    requestDraw()
  }

  const controlClass = "flex size-7 items-center justify-center text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"

  return (
    <div ref={containerRef} className="relative h-full min-h-0 w-full overflow-hidden bg-[#fbfaf7] dark:bg-[#1b1a18]">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={ariaLabel}
        className="absolute inset-0 block touch-none"
        style={{ cursor: "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onPointerCancel={() => { dragRef.current = null }}
        onPointerLeave={() => {
          if (dragRef.current) return
          hoverRef.current = null
          setTooltip(null)
          requestDraw()
        }}
      />

      {tooltip ? (
        <div
          className={cn(
            "pointer-events-none absolute z-10 max-w-[280px] rounded-lg bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-composer",
            tooltip.x > sizeRef.current.width - 300 && "-translate-x-full",
          )}
          style={{
            left: tooltip.x + (tooltip.x > sizeRef.current.width - 300 ? -14 : 14),
            top: Math.min(tooltip.y + 14, sizeRef.current.height - 96),
          }}
        >
          <p className="line-clamp-3 [overflow-wrap:anywhere]">{tooltip.node.label}</p>
          {tooltip.node.item ? (
            <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{tooltip.node.item.id}</p>
          ) : null}
        </div>
      ) : null}

      {emptyHint ? (
        <p className="pointer-events-none absolute inset-x-6 bottom-16 text-center text-[13px] text-muted-foreground">{emptyHint}</p>
      ) : null}

      <ul className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1">
        {legend.map((entry) => (
          <li key={entry.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={entry.hollow ? { boxShadow: `inset 0 0 0 1.5px ${entry.color}` } : { background: entry.color }}
            />
            {entry.label}
          </li>
        ))}
      </ul>

      <div className="absolute bottom-3 right-3 flex overflow-hidden rounded-lg bg-card shadow-card">
        <button type="button" aria-label={zoomOutLabel} title={zoomOutLabel} className={controlClass} onClick={() => zoomBy(0.8)}><Minus className="size-3.5" /></button>
        <button type="button" aria-label={fitLabel} title={fitLabel} className={controlClass} onClick={handleFit}><Maximize2 className="size-3" /></button>
        <button type="button" aria-label={zoomInLabel} title={zoomInLabel} className={controlClass} onClick={() => zoomBy(1.25)}><Plus className="size-3.5" /></button>
      </div>
    </div>
  )
}
