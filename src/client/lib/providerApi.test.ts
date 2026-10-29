import { expect, test } from "bun:test"
import { PROVIDERS } from "../../shared/types"
import { requestProviders } from "./providerApi"

test("reads the server's real model catalog without a condition policy", async () => {
  const providers = [{ ...PROVIDERS[0], models: [{ ...PROVIDERS[0].models[0], id: "configured-model" }] }]
  expect(await requestProviders(async () => Response.json({ data: providers }))).toEqual(providers)
})

test("rejects unavailable or malformed provider responses", async () => {
  await expect(requestProviders(async () => new Response("offline", { status: 503 }))).rejects.toThrow("503")
  await expect(requestProviders(async () => Response.json({ providers: [] }))).rejects.toThrow("missing data")
})
