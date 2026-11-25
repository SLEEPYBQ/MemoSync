function trackBackendProcess(child) {
  let stopped = false
  let exitCode = null
  let resolveStopped
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve })
  const markStopped = () => {
    if (stopped) return
    stopped = true
    resolveStopped()
  }
  child.once("error", markStopped)
  child.once("exit", (code) => { exitCode = code; markStopped() })
  return {
    get stopped() { return stopped },
    get exitCode() { return exitCode },
    waitForStop: () => stopped ? Promise.resolve() : stoppedPromise,
  }
}

// An update must not replace a runtime that is still writing its data. Unlike
// ordinary forced quit, a timeout here aborts installation.
async function stopBackendForUpdate(child, lifecycle, timeoutMs = 20_000) {
  let timer
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The local backend did not stop. Please restart MemoSync before installing the update.")), timeoutMs)
    })
    if (!lifecycle.stopped) child.stdin.end(`${JSON.stringify({ type: "stop" })}\n`)
    await Promise.race([lifecycle.waitForStop(), timeout])
    if (lifecycle.exitCode !== 0) throw new Error("The local backend could not shut down cleanly. Please restart MemoSync before installing the update.")
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { trackBackendProcess, stopBackendForUpdate }
