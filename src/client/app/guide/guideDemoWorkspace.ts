// The guide tour's fake workspace: enough of the web-shop project that the
// REAL side-panel components (FilesPanel, BrowserPanel) render live against
// it. FilesPanel talks HTTP, so a scoped fetch shim answers its routes for
// the demo project id only; BrowserPanel talks the app socket, so a stub
// socket answers its two commands. Nothing here touches real projects.
import type { LocalHttpServerInfo, ProjectQuickAction } from "../../../shared/protocol"
import type { AppSocket } from "../socket"
import {
  GUIDE_BOARD_PENDING_DEMO,
  createGuideBoardDemoController,
  type GuideBoardDemo,
  type GuideBoardDemoSnapshot,
} from "./guideBoardDemo"

export const GUIDE_CHAT_ID = "guide-demo"
export const GUIDE_PROJECT_ID = "guide-demo-shop"

/**
 * A self-contained app for the Browser lesson. It runs through iframe srcDoc,
 * so clicking the real server card, Home, and Refresh exercises the mounted
 * BrowserPanel without contacting localhost or a participant project.
 */
export const GUIDE_BROWSER_DEMO_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f5ef; color: #271d1d; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid #ded8ca; background: #fffdf8; }
    .brand { font-size: 17px; font-weight: 750; letter-spacing: -0.02em; }
    .cart { border-radius: 999px; background: #6f1d2c; color: white; padding: 7px 11px; font-size: 12px; font-weight: 700; }
    main { max-width: 780px; margin: 0 auto; padding: 34px 24px 48px; }
    h1 { max-width: 560px; margin: 0; font-size: clamp(28px, 5vw, 46px); line-height: 1.05; letter-spacing: -0.045em; }
    .lede { margin: 12px 0 24px; color: #6d6262; line-height: 1.55; }
    .toolbar { display: flex; gap: 10px; margin-bottom: 18px; }
    input { min-width: 0; flex: 1; border: 1px solid #cec6b8; border-radius: 10px; background: white; padding: 10px 12px; font: inherit; }
    .product { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: center; border: 1px solid #ded8ca; border-radius: 16px; background: #fffdf8; padding: 20px; box-shadow: 0 12px 35px rgba(62, 41, 41, 0.07); }
    .eyebrow { color: #8b7373; font-size: 11px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h2 { margin: 5px 0 7px; font-size: 20px; }
    .meta { margin: 0; color: #756969; font-size: 13px; }
    button { border: 0; border-radius: 10px; cursor: pointer; padding: 10px 14px; font: inherit; font-size: 13px; font-weight: 750; }
    .primary { background: #6f1d2c; color: white; }
    .secondary { border: 1px solid #cfc5b8; background: white; color: #3a2c2c; }
    .cart-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; border-top: 1px solid #ded8ca; padding-top: 18px; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    dialog { width: min(390px, calc(100% - 32px)); border: 1px solid #ded8ca; border-radius: 16px; padding: 0; box-shadow: 0 24px 70px rgba(40, 23, 23, .25); }
    dialog::backdrop { background: rgba(35, 24, 24, .38); }
    .dialog-body { padding: 22px; }
    .dialog-body h3 { margin: 0 0 8px; }
    .dialog-body p { color: #716464; line-height: 1.5; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
    .notice { min-height: 22px; margin-top: 12px; color: #6f1d2c; font-size: 13px; font-weight: 650; }
    @media (max-width: 560px) { .product { grid-template-columns: 1fr; } .product button { width: 100%; } }
  </style>
</head>
<body data-guide-demo-app="true">
  <header><span class="brand">Northstar Market</span><span class="cart" id="cart-count">Cart · 1</span></header>
  <main>
    <div class="eyebrow">Browser practice app</div>
    <h1>Try a complete user flow.</h1>
    <p class="lede">Search the catalog, add an item, then clear the cart and confirm the destructive action.</p>
    <div class="toolbar"><input id="search" aria-label="Search products" placeholder="Search products"><button class="secondary" id="search-button">Search</button></div>
    <section class="product" id="product-card">
      <div><div class="eyebrow">In stock</div><h2>Canvas weekend tote</h2><p class="meta">Durable cotton · $36</p></div>
      <button class="primary" data-demo-action="add-to-cart">Add to cart</button>
    </section>
    <div class="notice" id="notice" aria-live="polite"></div>
    <div class="cart-actions"><span id="cart-summary">1 item in your cart</span><button class="secondary" data-demo-action="clear-cart">Clear cart</button></div>
  </main>
  <dialog id="clear-dialog">
    <div class="dialog-body"><h3>Clear your cart?</h3><p>This removes every item. You can cancel and keep shopping.</p><div class="dialog-actions"><button class="secondary" data-demo-action="cancel-clear">Cancel</button><button class="primary" data-demo-action="confirm-clear">Yes, clear cart</button></div></div>
  </dialog>
  <script>
    let count = 1;
    const countChip = document.querySelector('#cart-count');
    const summary = document.querySelector('#cart-summary');
    const notice = document.querySelector('#notice');
    const clearButton = document.querySelector('[data-demo-action="clear-cart"]');
    const dialog = document.querySelector('#clear-dialog');
    function render() {
      countChip.textContent = 'Cart · ' + count;
      summary.textContent = count === 1 ? '1 item in your cart' : count + ' items in your cart';
      clearButton.disabled = count === 0;
      if (count === 0) summary.textContent = 'Your cart is empty';
    }
    document.querySelector('[data-demo-action="add-to-cart"]').addEventListener('click', () => { count += 1; notice.textContent = 'Added the tote to your cart.'; render(); });
    clearButton.addEventListener('click', () => dialog.showModal());
    document.querySelector('[data-demo-action="cancel-clear"]').addEventListener('click', () => dialog.close());
    document.querySelector('[data-demo-action="confirm-clear"]').addEventListener('click', () => { count = 0; notice.textContent = 'Cart cleared.'; dialog.close(); render(); });
    document.querySelector('#search-button').addEventListener('click', () => { const query = document.querySelector('#search').value.trim(); notice.textContent = query ? 'Showing results for “' + query + '”.' : 'Type a product name to search.'; });
    render();
  </script>
</body>
</html>`

/** The shop project the demo conversation works on (paths match the scenes). */
const DEMO_FILES: Record<string, string> = {
  "package.json": `{
  "name": "web-shop",
  "private": true,
  "scripts": {
    "dev": "bun run server/index.ts",
    "client": "vite client"
  }
}
`,
  "README.md": `# web-shop

A small shop: React client (client/src) + Fastify API (server/routes).

- \`bun dev\` starts the API on port 3000
- \`bun client\` starts the storefront on port 5173
`,
  "client/src/App.tsx": `import { CartProvider } from "./cart/CartContext"
import { CartPage } from "./pages/CartPage"

export function App() {
  return (
    <CartProvider>
      <CartPage />
    </CartProvider>
  )
}
`,
  "client/src/cart/CartContext.tsx": `import { createContext, useContext, useMemo, useState } from "react"

// All cart changes go through these actions so the header badge,
// totals, and the cart page stay in sync.
export function CartProvider({ children }) {
  const [items, setItems] = useState([])
  const actions = useMemo(
    () => ({
      addItem: (item) => setItems((current) => [...current, item]),
      removeItem: (id) => setItems((current) => current.filter((i) => i.id !== id)),
      clearCart: () => setItems([]),
    }),
    []
  )
  return <CartContext.Provider value={{ items, ...actions }}>{children}</CartContext.Provider>
}

const CartContext = createContext(null)
export const useCart = () => useContext(CartContext)
`,
  "client/src/cart/cartApi.ts": `export async function syncCart(items) {
  await fetch("/api/cart", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })
}
`,
  "client/src/pages/CartPage.tsx": `import { useCart } from "../cart/CartContext"
import { CartLineItems } from "../components/CartLineItems"
import { ClearCartButton } from "../components/ClearCartButton"

export function CartPage() {
  const { items, clearCart } = useCart()
  return (
    <main>
      <h1>Your cart</h1>
      <CartLineItems items={items} />
      <ClearCartButton onConfirm={clearCart} />
    </main>
  )
}
`,
  "client/src/pages/CatalogPage.tsx": `export function CatalogPage() {
  return <main>catalog…</main>
}
`,
  "client/src/pages/CheckoutPage.tsx": `export function CheckoutPage() {
  return <main>checkout…</main>
}
`,
  "client/src/lib/money.ts": `// All product prices render through this helper.
export function formatPrice(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}
`,
  "server/index.ts": `import Fastify from "fastify"
import { cartRoutes } from "./routes/cart"
import { productRoutes } from "./routes/products"

const app = Fastify()
app.register(cartRoutes, { prefix: "/api/cart" })
app.register(productRoutes, { prefix: "/api/products" })
app.listen({ port: 3000 })
`,
  "server/routes/cart.ts": `export async function cartRoutes(app) {
  app.get("/", async () => ({ items: [] }))
  app.put("/", async (request) => ({ items: request.body.items }))
}
`,
  "server/routes/products.ts": `export async function productRoutes(app) {
  app.get("/", async () => ({ products: [] }))
}
`,
}

interface DemoFileEntry {
  name: string
  kind: "file" | "dir"
  size: number
}

/** Immediate children of `dir` ("" = root), dirs first then files, sorted. */
function listDemoDir(dir: string): DemoFileEntry[] {
  const prefix = dir ? `${dir}/` : ""
  const dirs = new Set<string>()
  const files: DemoFileEntry[] = []
  for (const [path, content] of Object.entries(DEMO_FILES)) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash === -1) files.push({ name: rest, kind: "file", size: content.length })
    else dirs.add(rest.slice(0, slash))
  }
  return [
    ...[...dirs].sort().map((name) => ({ name, kind: "dir" as const, size: 0 })),
    ...files.sort((a, b) => a.name.localeCompare(b.name)),
  ]
}

function searchDemoFiles(query: string) {
  const q = query.toLowerCase()
  const results: Array<{ path: string; line: number; text: string; col: number }> = []
  for (const [path, content] of Object.entries(DEMO_FILES)) {
    content.split("\n").forEach((text, index) => {
      const col = text.toLowerCase().indexOf(q)
      if (col !== -1) results.push({ path, line: index + 1, text: text.trim(), col })
    })
  }
  return { results, truncated: false }
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function failClosed(pathname: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "guide_demo_only",
        message: `The Guide does not expose participant data at ${pathname}.`,
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  )
}

/**
 * Answer FilesPanel's routes for the demo project; every other request falls
 * through to the real fetch untouched. Returns the uninstaller.
 */
export interface GuideFetchShimController {
  (): void
  setBoardDemo(demo: GuideBoardDemo): void
  getBoardDemo(): GuideBoardDemoSnapshot
  subscribeBoard(listener: (snapshot: GuideBoardDemoSnapshot) => void): () => void
}

export function installGuideFetchShim(): GuideFetchShimController {
  const realFetch = window.fetch.bind(window)
  const boardDemo = createGuideBoardDemoController(GUIDE_BOARD_PENDING_DEMO)
  const filesPrefix = `/api/projects/${GUIDE_PROJECT_ID}/files`
  const memoryFilePath = `/api/projects/${GUIDE_PROJECT_ID}/memory-file`
  let memoryFileContent = [
    "# Memory",
    "",
    "## Project facts",
    "- Cart state lives in `client/src/cart/CartContext.tsx`.",
    "",
    "## Preferences",
    "- Ask for confirmation before destructive actions.",
  ].join("\n")
  let memoryFileMtime = 1_723_280_400_000
  const summary = {
    text: [
      "## Project",
      "The cart is managed through `CartContext`, and product prices use the shared `formatPrice` helper.",
      "",
      "## Preferences",
      "Ask for confirmation before destructive actions and avoid adding dependencies when the repository already has what is needed.",
    ].join("\n"),
    updatedAt: "2026-08-10T09:00:00.000Z",
    stale: false,
  }

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) {
      return realFetch(input, init)
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const body = (): Record<string, unknown> => {
      if (typeof init?.body !== "string") return {}
      try {
        const parsed = JSON.parse(init.body) as unknown
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
      } catch {
        return {}
      }
    }
    // Study surfaces (tour contract steps): the REAL StudyIndexPage / StudyDock
    // and the protected brief render against this demo study state — one
    // session done, one active, two locked behind the serial gate.
    if (url.pathname === "/api/study/progress") {
      return Promise.resolve(
        json({
          activeTaskId: "038-S2",
          postSessionPending: false,
          freezeState: "open",
          questionnairePending: false,
          susPending: false,
          studyComplete: false,
          tasks: [
            { id: "038-S1", title: "Apartment rentals · Session 1", status: "completed" },
            { id: "038-S2", title: "Apartment rentals · Session 2", status: "active" },
            { id: "098-S1", title: "Car rentals · Session 1", status: "locked" },
            { id: "098-S2", title: "Car rentals · Session 2", status: "locked" },
          ],
        }),
      )
    }
    if (url.pathname.startsWith("/api/study/task/")) {
      if (url.pathname.endsWith("/acknowledge")) return Promise.resolve(json({ acknowledged: true }))
      return Promise.resolve(
        json({
          id: "038-S2",
          title: "Apartment rentals · Session 2",
          status: "active",
          brief: [
            "Continue the apartment rentals application from Session 1.",
            "Add a booking flow: pick dates on a listing, review the price summary, and confirm the booking.",
            "Keep the existing browsing and search features working.",
          ],
          projectSlug: "apartment",
          projectTitle: "Apartment rentals",
          projectId: GUIDE_PROJECT_ID,
          starterReady: true,
          briefAcknowledged: true,
        }),
      )
    }
    if (url.pathname === "/api/study/instruction-guard-event") {
      return Promise.resolve(json({ recorded: true }))
    }
    // Production Board components run in the Guide, but every read is served
    // from tutorial-owned fixtures. No request in these namespaces may fall
    // through to a participant's memory or workspace backend.
    if (url.pathname === "/api/memories" && method === "GET") {
      return Promise.resolve(json(boardDemo.snapshot().items))
    }
    if (url.pathname === "/api/memories/needs-attention" && method === "GET") {
      return Promise.resolve(json({ items: [] }))
    }
    if (url.pathname === "/api/projects" && method === "GET") {
      return Promise.resolve(json([{ id: GUIDE_PROJECT_ID, title: "Guide demo shop" }]))
    }
    if (url.pathname === "/api/chats" && method === "GET") {
      return Promise.resolve(json([{
        id: "guide-prior-chat",
        title: "Earlier guide session",
        projectId: GUIDE_PROJECT_ID,
      }]))
    }
    if (url.pathname === "/api/memories/md-status" && method === "GET") {
      return Promise.resolve(json({
        files: [
          { scope: "personal", path: "/guide/memory/personal.md" },
          { scope: "project", projectId: GUIDE_PROJECT_ID, path: "/guide/memory/project.md" },
        ],
      }))
    }
    if (url.pathname === "/api/memories/md-file" && method === "GET") {
      const project = url.searchParams.get("project")
      return Promise.resolve(json(project === GUIDE_PROJECT_ID
        ? {
            path: "/guide/memory/project.md",
            content: [
              "# Project Memory",
              "",
              "- Cart state lives in `client/src/cart/CartContext.tsx`.",
              "- Ask for confirmation before destructive actions.",
            ].join("\n"),
          }
        : {
            path: "/guide/memory/personal.md",
            content: "# Personal Memory\n\n- Prefer small, testable changes.",
          }))
    }
    if (url.pathname === "/api/memories/board-review" && method === "GET") {
      return Promise.resolve(json(boardDemo.snapshot().status))
    }
    const revertAutoMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/revert-auto$/)
    if (revertAutoMatch && method === "POST") {
      const id = decodeURIComponent(revertAutoMatch[1]!)
      const item = boardDemo.snapshot().items.find((candidate) => candidate.id === id)
      if (!item || item.status !== "active") return Promise.resolve(failClosed(url.pathname))
      try {
        const reverted = boardDemo.updateMemory(id, { status: "candidate" })
        return Promise.resolve(json({ reverted, restored: null }))
      } catch (error) {
        return Promise.resolve(failClosed(error instanceof Error ? error.message : url.pathname))
      }
    }
    const restoreCandidateMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/restore-candidate$/)
    if (restoreCandidateMatch && method === "POST") {
      const id = decodeURIComponent(restoreCandidateMatch[1]!)
      const item = boardDemo.snapshot().items.find((candidate) => candidate.id === id)
      if (!item || item.sensitive || item.status !== "discarded") {
        return Promise.resolve(failClosed(url.pathname))
      }
      return Promise.resolve(json(boardDemo.updateMemory(id, { status: "candidate" })))
    }
    const memoryIdMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/)
    if (memoryIdMatch && method === "PATCH") {
      const values = body()
      const { surface: _surface, ...patch } = values
      try {
        return Promise.resolve(json(boardDemo.updateMemory(decodeURIComponent(memoryIdMatch[1]!), patch)))
      } catch (error) {
        return Promise.resolve(failClosed(error instanceof Error ? error.message : url.pathname))
      }
    }
    if (memoryIdMatch && method === "DELETE") {
      const id = decodeURIComponent(memoryIdMatch[1]!)
      const item = boardDemo.snapshot().items.find((candidate) => candidate.id === id)
      if (!item) return Promise.resolve(failClosed(url.pathname))
      if (item.status === "candidate" && item.sensitive) boardDemo.removeMemory(id)
      else if (item.status === "candidate") boardDemo.updateMemory(id, { status: "discarded" })
      else boardDemo.updateMemory(id, { status: "archived" })
      return Promise.resolve(json({ id }))
    }
    const transferMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/transfer$/)
    if (transferMatch && method === "POST") {
      const values = body()
      if (typeof values.content !== "string" || typeof values.targetScope !== "string") {
        return Promise.resolve(failClosed(url.pathname))
      }
      return Promise.resolve(json(boardDemo.resolveTransfer(decodeURIComponent(transferMatch[1]!), values as never)))
    }
    const declineMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/transfer-decline$/)
    if (declineMatch && method === "POST") {
      boardDemo.declineTransfer(body().boardResolution as never)
      return Promise.resolve(json({ declined: true }))
    }
    if (url.pathname === "/api/memories/attention-resolve" && method === "POST") {
      const values = body()
      const id = typeof values.id === "string" ? values.id : ""
      if (!id) return Promise.resolve(failClosed(url.pathname))
      let updated
      try {
        updated = boardDemo.updateMemory(id, values.action === "archive" ? { status: "archived" } : {})
      } catch {
        return Promise.resolve(failClosed(url.pathname))
      }
      boardDemo.resolveCheckup(values.boardResolution as never)
      return Promise.resolve(json(updated))
    }
    if (url.pathname === "/api/memories/pay-attention" && method === "POST") {
      const values = body()
      const id = typeof values.id === "string" ? values.id : ""
      if (!id || !boardDemo.snapshot().items.some((item) => item.id === id)) {
        return Promise.resolve(failClosed(url.pathname))
      }
      return Promise.resolve(json({ queued: id }))
    }
    if (url.pathname === "/api/memories/summary") {
      return Promise.resolve(json(summary))
    }
    if (url.pathname === "/api/memories/summary/refresh") {
      return Promise.resolve(json(summary))
    }
    if (url.pathname === "/api/memories/summary/chat") {
      return Promise.resolve(json({
        reply: "In the live panel, the assistant would confirm the requested memory update here.",
        applied: 0,
        summary,
      }))
    }
    if (url.pathname === memoryFilePath) {
      if (method === "PUT") {
        try {
          const body = typeof init?.body === "string" ? JSON.parse(init.body) as { content?: unknown } : null
          if (typeof body?.content === "string") memoryFileContent = body.content
        } catch {
          // The production panel reports malformed input; the guide never
          // needs to make a real request as a fallback.
        }
        memoryFileMtime += 1
        return Promise.resolve(json({ path: "MEMORY.md", mtimeMs: memoryFileMtime }))
      }
      return Promise.resolve(json({
        path: "MEMORY.md",
        content: memoryFileContent,
        mtimeMs: memoryFileMtime,
        exists: true,
      }))
    }
    if (!url.pathname.startsWith(filesPrefix)) {
      if (
        url.pathname === "/api/memories"
        || url.pathname.startsWith("/api/memories/")
        || url.pathname === "/api/projects"
        || url.pathname.startsWith("/api/projects/")
        || url.pathname === "/api/chats"
        || url.pathname.startsWith("/api/chats/")
      ) {
        return Promise.resolve(failClosed(url.pathname))
      }
      return realFetch(input, init)
    }
    const rest = url.pathname.slice(filesPrefix.length)
    if (rest === "" || rest === "/") {
      return Promise.resolve(json({ dir: url.searchParams.get("dir") ?? "", entries: listDemoDir(url.searchParams.get("dir") ?? "") }))
    }
    if (rest === "/index") {
      return Promise.resolve(json({ files: Object.keys(DEMO_FILES).sort(), truncated: false }))
    }
    if (rest === "/search") {
      return Promise.resolve(json(searchDemoFiles(url.searchParams.get("q") ?? "")))
    }
    if (rest === "/op") {
      // Tree edits have nowhere to land in a demo; succeed as a no-op.
      return Promise.resolve(json({ ok: true }))
    }
    const contentMatch = rest.match(/^\/(.+)\/content$/)
    if (contentMatch) {
      const path = decodeURIComponent(contentMatch[1])
      const content = DEMO_FILES[path]
      if ((init?.method ?? "GET").toUpperCase() === "PUT") return Promise.resolve(json({ ok: true }))
      if (content === undefined) return Promise.resolve(new Response("not found", { status: 404 }))
      return Promise.resolve(new Response(content, { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } }))
    }
    return Promise.resolve(failClosed(url.pathname))
  }) as typeof window.fetch

  const cleanup = (() => {
    window.fetch = realFetch
  }) as GuideFetchShimController
  cleanup.setBoardDemo = (demo) => boardDemo.reset(demo)
  cleanup.getBoardDemo = () => boardDemo.snapshot()
  cleanup.subscribeBoard = (listener) => boardDemo.subscribe(listener)
  return cleanup
}

const DEMO_SERVERS: LocalHttpServerInfo[] = [
  {
    title: "web-shop storefront",
    address: "http://localhost:5173",
    port: 5173,
    status: 200,
    ownerPath: "/home/user/web-shop",
    processName: "bun",
    sameProject: true,
    preferProxy: true,
  },
  {
    title: "web-shop API",
    address: "http://localhost:3000",
    port: 3000,
    status: 200,
    ownerPath: "/home/user/web-shop",
    processName: "bun",
    sameProject: true,
    preferProxy: true,
  },
]

const DEMO_QUICK_ACTIONS: ProjectQuickAction[] = [
  { id: "guide-qa-dev", label: "bun dev", command: "bun dev" },
  { id: "guide-qa-client", label: "bun client", command: "bun client" },
]

/** Enough of AppSocket for BrowserPanel's two read commands. */
export const guideDemoSocket = {
  command: async (command: { type: string }) => {
    if (command.type === "browser.listLocalHttpServers") return DEMO_SERVERS
    if (command.type === "project.readQuickActions") return DEMO_QUICK_ACTIONS
    return []
  },
} as unknown as AppSocket
