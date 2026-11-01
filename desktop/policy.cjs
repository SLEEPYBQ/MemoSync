function isAppUrl(value, origin) {
  try {
    const url = new URL(value)
    return url.origin === origin && !url.username && !url.password
  } catch {
    return false
  }
}

function isExternalUrl(value) {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

function isAppContentUrl(value, origin) {
  if (!isAppUrl(value, origin)) return false
  try {
    return /^\/api\/projects\/[^/]+\/(?:uploads|files)\/[^/]+\/content$/.test(new URL(value).pathname)
  } catch {
    return false
  }
}

function parseReadyLine(line) {
  const prefix = "MEMOSYNC_DESKTOP_READY:"
  if (!line.startsWith(prefix)) return null
  const { port } = JSON.parse(line.slice(prefix.length))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid backend port")
  return `http://127.0.0.1:${port}`
}

module.exports = { isAppContentUrl, isAppUrl, isExternalUrl, parseReadyLine }
