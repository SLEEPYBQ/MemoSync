import { useState } from "react"
import { createRoot } from "react-dom/client"
import { PROVIDERS } from "../../../../../shared/types"
import { TooltipProvider } from "../../../ui/tooltip"
import { ChatInput } from "../../ChatInput"

function UploadFixture() {
  const [submitted, setSubmitted] = useState("")
  return (
    <TooltipProvider>
      <ChatInput
        disabled={false}
        chatId="http-upload-chat"
        projectId="http-upload-project"
        activeProvider="codex"
        availableProviders={PROVIDERS}
        onSubmit={async (value, options) => {
          setSubmitted(JSON.stringify({ value, attachments: options?.attachments }))
        }}
      />
      <output data-testid="submitted">{submitted}</output>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(<UploadFixture />)
