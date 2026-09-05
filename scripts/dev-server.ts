import process from "node:process"

process.env.MEMOSYNC_RUNTIME_PROFILE = "dev"
process.env.MEMOSYNC_DISABLE_SELF_UPDATE = "1"

await import("../src/server/cli")
