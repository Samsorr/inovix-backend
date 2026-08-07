// Guards the locking-module registration in medusa-config.js.
//
// reserveInventoryStep serialises createReservationItems per inventory item
// through Modules.LOCKING. Medusa always registers a locking module (defineConfig
// adds `{ resolve: "@medusajs/medusa/locking" }` with no options), but without an
// explicit provider it uses the in-memory one, whose state is a Map on a
// per-process singleton. That is invisible on one replica and an oversell the
// moment there are two, so what needs pinning is the PROVIDER, not the module.
//
// Package names are asserted against @medusajs/utils' own MODULE_PACKAGE_NAMES /
// TEMPORARY_REDIS_MODULE_PACKAGE_NAMES rather than hardcoded strings, and both are
// require.resolve'd, so a name that only resolves by accident on this machine
// (bare "@medusajs/locking-redis" is a transitive dep of @medusajs/medusa, not a
// declared dep of this app) cannot pass.

import {
  Modules,
  MODULE_PACKAGE_NAMES,
  TEMPORARY_REDIS_MODULE_PACKAGE_NAMES,
} from "@medusajs/utils"

type ProviderEntry = {
  resolve?: string
  id?: string
  is_default?: boolean
  options?: Record<string, unknown>
}

type ModuleEntry = {
  resolve?: string
  options?: { providers?: ProviderEntry[]; redisUrl?: string }
}

type LoadedConfig = { modules: Record<string, ModuleEntry> }

const TEST_REDIS_URL = "redis://locking-test-host:6379"

// lib/constants calls loadEnv() itself, so deleting process.env.REDIS_URL is not
// enough | the repo's .env would fill it back in. Mock the constants module
// instead so "Redis is not configured" is expressed exactly.
function loadConfig(redisUrl: string | undefined): LoadedConfig {
  jest.resetModules()
  const actual = jest.requireActual("lib/constants")
  jest.doMock("lib/constants", () => ({ ...actual, REDIS_URL: redisUrl }))
  return require("../../medusa-config").default
}

describe("medusa-config locking module", () => {
  it("registers the Redis locking provider when REDIS_URL is set", () => {
    const locking = loadConfig(TEST_REDIS_URL).modules[Modules.LOCKING]

    expect(locking).toBeDefined()
    expect(locking.resolve).toBe(MODULE_PACKAGE_NAMES[Modules.LOCKING])

    const providers = locking.options?.providers ?? []
    expect(providers).toHaveLength(1)

    const [provider] = providers
    expect(provider.resolve).toBe(
      TEMPORARY_REDIS_MODULE_PACKAGE_NAMES[Modules.LOCKING]
    )
    expect(provider.id).toBe("locking-redis")
    expect(provider.is_default).toBe(true)
  })

  it("points the lock at the same Redis the rest of the config uses", () => {
    const { modules } = loadConfig(TEST_REDIS_URL)
    const provider = modules[Modules.LOCKING].options!.providers![0]

    expect(provider.options).toEqual({ redisUrl: TEST_REDIS_URL })
    expect(modules[Modules.CACHE].options?.redisUrl).toBe(TEST_REDIS_URL)
  })

  it("resolves both package names from this app's own dependency tree", () => {
    const locking = loadConfig(TEST_REDIS_URL).modules[Modules.LOCKING]
    const provider = locking.options!.providers![0]

    expect(() => require.resolve(locking.resolve!)).not.toThrow()
    expect(() => require.resolve(provider.resolve!)).not.toThrow()

    // The provider id must match the identifier of a service the provider
    // package exports, otherwise is_default points at nothing.
    const loaded = require(provider.resolve!)
    const services = (loaded.default ?? loaded).services as Array<{
      identifier: string
    }>
    expect(services.map((s) => s.identifier)).toContain(provider.id)
  })

  it("configures no Redis provider without REDIS_URL, so local dev keeps the in-memory default", () => {
    const { modules } = loadConfig(undefined)

    // Medusa still registers the locking module by default, but with no
    // providers | that is the in-memory fallback, which is what local dev wants.
    expect(modules[Modules.LOCKING]?.options?.providers).toBeUndefined()
    expect(modules[Modules.CACHE]?.resolve).not.toBe("@medusajs/cache-redis")
  })
})
