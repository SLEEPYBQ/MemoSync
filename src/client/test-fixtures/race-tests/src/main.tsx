const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")

const view = new URLSearchParams(window.location.search).get("view")
if (view === "terminal-workspace") {
  void import("./terminalWorkspaceFixture").then(({ mountTerminalWorkspaceFixture }) => mountTerminalWorkspaceFixture(root))
} else if (view === "app-state") {
  void import("./appStateFixture").then(({ mountAppStateFixture }) => mountAppStateFixture(root))
} else {
  void import("./chatInputFixture").then(({ mountChatInputFixture }) => mountChatInputFixture(root))
}
