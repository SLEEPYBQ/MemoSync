import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { FilesPanel } from "../../../components/chat-ui/FilesPanel"
import { TooltipProvider } from "../../../components/ui/tooltip"
import { ThemeProvider } from "../../../hooks/useTheme"
import { fileEditorDrafts } from "../../../lib/fileEditorDrafts"

export function mountFilesEditorFixture(root: HTMLElement) {
  function Fixture() {
    const [project, setProject] = useState("project-a")
    const [mounted, setMounted] = useState(true)
    Object.assign(window, { __filesEditorFixture: {
      setProject,
      setMounted,
      buffer: (projectId: string, path = "note.txt") => fileEditorDrafts(projectId).getSnapshot().buffers.get(path) ?? null,
    } })
    return <main style={{ width: 900, height: 600 }}>
      <div data-testid="fixture-ready" />
      {mounted && <FilesPanel key={project} projectId={project} />}
    </main>
  }
  createRoot(root).render(<StrictMode><MemoryRouter><ThemeProvider><TooltipProvider><Fixture /></TooltipProvider></ThemeProvider></MemoryRouter></StrictMode>)
}
