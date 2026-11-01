function trackBackendProcess(child) {
  let stopped = false
  let resolveStopped
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve })
  const markStopped = () => {
    if (stopped) return
    stopped = true
    resolveStopped()
  }
  child.once("error", markStopped)
  child.once("exit", markStopped)
  return {
    get stopped() { return stopped },
    waitForStop: () => stopped ? Promise.resolve() : stoppedPromise,
  }
}

module.exports = { trackBackendProcess }
