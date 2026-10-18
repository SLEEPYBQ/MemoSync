import { useState } from "react"
import { createRoot } from "react-dom/client"
import { copyTextToClipboard } from "../../../../lib/clipboard"
import { MetaCodeBlock } from "../../shared"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../ui/dialog"

Object.assign(window, { copyForTest: copyTextToClipboard })

function ClipboardFixture() {
  const [open, setOpen] = useState(false)
  return (
  <>
    <div data-testid="code"><MetaCodeBlock label="Example">{"echo 你好\nsecond line"}</MetaCodeBlock></div>
    <textarea id="paste" aria-label="Paste destination" defaultValue="" />
    <textarea id="draft" aria-label="Draft" defaultValue="unfinished draft" />
    <p id="selection">Selection to preserve</p>
    <button onClick={() => setOpen(true)}>Open modal</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Modal copy</DialogTitle>
        <DialogDescription>Verify copying inside the focus trap.</DialogDescription>
        <div data-testid="modal-code"><MetaCodeBlock label="Modal example">{"modal copy\n你好"}</MetaCodeBlock></div>
        <textarea aria-label="Modal paste destination" defaultValue="" />
      </DialogContent>
    </Dialog>
  </>
  )
}

createRoot(document.getElementById("root")!).render(<ClipboardFixture />)
