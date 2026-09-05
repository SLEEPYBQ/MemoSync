import { describe, expect, test } from "bun:test"
import { studyProjectSubprocessEnv } from "./study-project-runtime"

const manifest = JSON.stringify([
  { localPath: "/workspace/apartment", title: "Apartment rentals" },
  { localPath: "/workspace/car", title: "Car rentals" },
])

describe("study project subprocess environment", () => {
  test("applies starter runtime settings to an assigned cwd without leaking the MemoSync server port", () => {
    const base = {
      PORT: "3210",
      NODE_ENV: "production",
      KEEP_ME: "yes",
    }

    const apartment = studyProjectSubprocessEnv(base, "/workspace/apartment", manifest)

    expect(apartment).toMatchObject({
      KEEP_ME: "yes",
      NODE_ENV: "development",
      npm_config_include: "dev",
      NEXT_PRIVATE_OUTPUT_TRACE_ROOT: "/",
    })
    expect(apartment.PORT).toBeUndefined()
  })

  test("does not apply study runtime settings to an unassigned cwd", () => {
    expect(studyProjectSubprocessEnv(
      { PORT: "9999", NODE_ENV: "production" },
      "/workspace/lookalike/apartment",
      manifest,
    )).toEqual({ PORT: "9999", NODE_ENV: "production" })
  })
})
