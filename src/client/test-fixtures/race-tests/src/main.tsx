const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")

const view = new URLSearchParams(window.location.search).get("view")
if (view === "file-editor") {
  void import("./filesEditorFixture").then(({ mountFilesEditorFixture }) => mountFilesEditorFixture(root))
} else if (view === "terminal-workspace") {
  void import("./terminalWorkspaceFixture").then(({ mountTerminalWorkspaceFixture }) => mountTerminalWorkspaceFixture(root))
} else if (view === "app-state" || view === "landing") {
  void import("./appStateFixture").then(({ mountAppStateFixture }) => mountAppStateFixture(root))
} else if (view === "question-git") {
  void import("./questionGitFixture").then(({ mountQuestionGitFixture }) => mountQuestionGitFixture(root))
} else {
  void import("./chatInputFixture").then(({ mountChatInputFixture }) => mountChatInputFixture(root))
}
