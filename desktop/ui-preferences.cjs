const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs")
const path = require("node:path")

const validators = new Map([
  ["memosync:sidebar-width", (value) => /^\d{3}$/.test(value) && Number(value) >= 220 && Number(value) <= 520],
  ["memosync:memory-view", (value) => value === "board" || value === "graph"],
  ["memosync:dismissed-release", (value) => /^\d+(?:\.\d+){1,3}$/.test(value)],
  ["memosync:last-open-external", (value) => /^(?:finder|terminal|preview|default|editor:(?:cursor|vscode|xcode|windsurf|custom))$/.test(value)],
])

function isPreference(key, value) {
  return typeof value === "string" && value.length <= 80 && validators.get(key)?.(value) === true
}

function openUiPreferences(userData) {
  const file = path.join(userData, "ui-preferences.json")
  const tempFile = path.join(userData, "ui-preferences.json.tmp")
  const values = new Map()
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"))
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (isPreference(key, value)) values.set(key, value)
    }
  } catch {
    // A first launch or a damaged file starts with defaults.
  }

  let dirty = false
  return {
    get(key) {
      return values.get(key) ?? null
    },
    set(key, value) {
      if (!isPreference(key, value)) return
      if (values.get(key) !== value) {
        values.set(key, value)
        dirty = true
      }
      if (!dirty) return
      try {
        mkdirSync(userData, { recursive: true })
        writeFileSync(tempFile, JSON.stringify(Object.fromEntries(values)), { mode: 0o600 })
        renameSync(tempFile, file)
        dirty = false
      } catch {
        // Keep the current window usable when the profile cannot be written.
      }
    },
  }
}

module.exports = { openUiPreferences }
