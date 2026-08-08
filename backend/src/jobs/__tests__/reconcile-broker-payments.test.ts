jest.mock("../../lib/instrument", () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}))
jest.mock("../../lib/constants", () => ({
  BROKER_URL: "https://broker.test",
  BROKER_CLIENT_ID: "client_001",
  BROKER_HMAC_SECRET: "shhh",
  RELAY_BASE_URL: "https://payments-relay.nl",
  CF_KV_ACCOUNT_ID: "",
  CF_KV_NAMESPACE_ID: "",
  CF_KV_API_TOKEN: "",
}))

const mockGetPayment = jest.fn()
jest.mock("../../modules/payment-via-broker/client", () => ({
  BrokerClient: jest.fn(() => ({ getPayment: (ref: string) => mockGetPayment(ref) })),
}))

const mockRunWorkflow = jest.fn()
jest.mock("@medusajs/medusa/core-flows", () => ({
  completeCartWorkflow: jest.fn(() => ({ run: (args: unknown) => mockRunWorkflow(args) })),
}))

import reconcileBrokerPayments, {
  buildPaidNoOrderAlert,
  buildPaidNoOrderResolved,
  isPaidNoOrderAlertDue,
  paidNoOrderKey,
  selectRecentBrokerCarts,
} from "../reconcile-broker-payments"
import { Sentry } from "../../lib/instrument"

const NOW = 1_000_000_000_000
const HOUR = 60 * 60 * 1000

describe("selectRecentBrokerCarts", () => {
  it("returns {cartId, ref} for recent sessions that carry both", () => {
    const out = selectRecentBrokerCarts(
      [
        { data: { cart_id: "cart_a", ref: "pay_a" }, created_at: new Date(NOW - HOUR) },
        { data: { cart_id: "cart_b", ref: "pay_b" }, created_at: new Date(NOW - 2 * HOUR) },
      ],
      NOW
    )
    expect(out).toEqual([
      { cartId: "cart_a", ref: "pay_a" },
      { cartId: "cart_b", ref: "pay_b" },
    ])
  })

  it("drops sessions older than the lookback window", () => {
    const out = selectRecentBrokerCarts(
      [
        { data: { cart_id: "fresh", ref: "pay_f" }, created_at: new Date(NOW - HOUR) },
        { data: { cart_id: "stale", ref: "pay_s" }, created_at: new Date(NOW - 5 * HOUR) },
      ],
      NOW
    )
    expect(out).toEqual([{ cartId: "fresh", ref: "pay_f" }])
  })

  it("drops sessions missing a cart_id or ref", () => {
    const out = selectRecentBrokerCarts(
      [
        { data: { ref: "pay_x" }, created_at: new Date(NOW) },
        { data: { cart_id: "cart_y" }, created_at: new Date(NOW) },
        { data: null, created_at: new Date(NOW) },
        { data: { cart_id: "cart_ok", ref: "pay_ok" }, created_at: new Date(NOW) },
      ],
      NOW
    )
    expect(out).toEqual([{ cartId: "cart_ok", ref: "pay_ok" }])
  })

  it("dedupes per cart, keeping the newest ref (input ordered newest-first)", () => {
    const out = selectRecentBrokerCarts(
      [
        { data: { cart_id: "cart_dup", ref: "pay_new" }, created_at: new Date(NOW) },
        { data: { cart_id: "cart_dup", ref: "pay_old" }, created_at: new Date(NOW - HOUR) },
      ],
      NOW
    )
    expect(out).toEqual([{ cartId: "cart_dup", ref: "pay_new" }])
  })

  it("treats a missing created_at as out of window", () => {
    const out = selectRecentBrokerCarts(
      [{ data: { cart_id: "no_ts", ref: "pay_n" }, created_at: null }],
      NOW
    )
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// "Paid but no order": the alert the operator most needs. Detection existed
// (Sentry only); these pin the Telegram wiring, and both halves of the "does
// not spam / does not go silent" contract.
// ---------------------------------------------------------------------------

const TICK = new Date("2026-08-08T12:00:00.000Z")
const CART = "cart_01JZ8PAIDNOORDER"
const REF = "pay_01JZ8REF"

function makeTg() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    isConfigured: jest.fn(() => true),
    sendToAll: jest.fn().mockResolvedValue(undefined),
    notify: jest.fn().mockResolvedValue(true),
    findEvent: jest.fn(async (key: string) => rows.get(key) ?? null),
    touchEvent: jest.fn(async (key: string, kind: string, data: Record<string, unknown>) => {
      rows.set(key, { id: `evt_${key}`, key, kind, ...data })
    }),
    releaseAction: jest.fn(async (key: string) => {
      rows.delete(key)
    }),
  }
}

function makeContainer(tg: ReturnType<typeof makeTg>, opts: { completedAt?: string | null } = {}) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const container = {
    logger,
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "query") {
        return {
          graph: jest.fn().mockResolvedValue({
            data: [{ id: CART, completed_at: opts.completedAt ?? null }],
          }),
        }
      }
      if (key === "payment") {
        return {
          listPaymentSessions: jest.fn().mockResolvedValue([
            // Inside the 3h lookback relative to the faked system time.
            { id: "ps_1", data: { cart_id: CART, ref: REF }, created_at: new Date(TICK.getTime() - 10 * 60 * 1000) },
          ]),
        }
      }
      if (key === "telegram_ops") return tg
      return undefined
    }),
  }
  return container
}

describe("reconcile-broker-payments | paid but no order", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(TICK)
    mockGetPayment.mockResolvedValue({
      ref: REF,
      status: "captured",
      amountMinor: 9000,
      currencyCode: "EUR",
    })
    // Completion keeps failing: the workflow reports errors and no order.
    mockRunWorkflow.mockResolvedValue({ result: undefined, errors: [{ error: new Error("Not enough stock available") }] })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("pushes a Dutch alert naming the amount, the cart and the next step", async () => {
    const tg = makeTg()
    await reconcileBrokerPayments(makeContainer(tg) as never)

    expect(tg.sendToAll).toHaveBeenCalledTimes(1)
    const text = tg.sendToAll.mock.calls[0][0] as string
    expect(text).toContain("Paid, no order")
    expect(text).toContain("€90.00")
    expect(text).toContain(CART)
    expect(text).toContain(REF)
    expect(text).toContain("What to do:")
    expect(text.length).toBeLessThan(4096)
    expect(text).not.toContain("—")
    // The last-sent row is written AFTER the send, not claimed before it.
    expect(tg.touchEvent).toHaveBeenCalledWith(
      paidNoOrderKey(CART),
      "payment_stuck",
      expect.objectContaining({ sent_at: TICK })
    )
    expect(Sentry.captureMessage).toHaveBeenCalled()
  })

  it("does not spam: the next 5-minute tick with the same stuck cart stays quiet", async () => {
    const tg = makeTg()
    await reconcileBrokerPayments(makeContainer(tg) as never)
    expect(tg.sendToAll).toHaveBeenCalledTimes(1)

    jest.setSystemTime(new Date(TICK.getTime() + 5 * 60 * 1000))
    await reconcileBrokerPayments(makeContainer(tg) as never)
    jest.setSystemTime(new Date(TICK.getTime() + 10 * 60 * 1000))
    await reconcileBrokerPayments(makeContainer(tg) as never)

    expect(tg.sendToAll).toHaveBeenCalledTimes(1)
    // The Sentry record shares the gate, so the log does not fill up either.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
  })

  it("does not go silent: it repeats once the repeat window has passed", async () => {
    const tg = makeTg()
    await reconcileBrokerPayments(makeContainer(tg) as never)

    jest.setSystemTime(new Date(TICK.getTime() + 61 * 60 * 1000))
    await reconcileBrokerPayments(makeContainer(tg) as never)

    expect(tg.sendToAll).toHaveBeenCalledTimes(2)
    expect(tg.sendToAll.mock.calls[1][0]).toContain("Paid, no order")
  })

  it("says it is resolved once the cart becomes an order, and re-arms", async () => {
    const tg = makeTg()
    await reconcileBrokerPayments(makeContainer(tg) as never)
    expect(tg.rows.has(paidNoOrderKey(CART))).toBe(true)

    // Next tick: the cart carries completed_at.
    jest.setSystemTime(new Date(TICK.getTime() + 5 * 60 * 1000))
    await reconcileBrokerPayments(makeContainer(tg, { completedAt: "2026-08-08T12:03:00.000Z" }) as never)

    const last = tg.sendToAll.mock.calls.at(-1)![0] as string
    expect(last).toContain("Resolved")
    expect(last).toContain(CART)
    expect(tg.releaseAction).toHaveBeenCalledWith(paidNoOrderKey(CART))
    expect(tg.rows.has(paidNoOrderKey(CART))).toBe(false)
  })

  it("says it is resolved when the job itself completes the cart in a later tick", async () => {
    const tg = makeTg()
    await reconcileBrokerPayments(makeContainer(tg) as never)

    mockRunWorkflow.mockResolvedValue({ result: { id: "order_01JZ", display_id: 28413 }, errors: [] })
    jest.setSystemTime(new Date(TICK.getTime() + 5 * 60 * 1000))
    await reconcileBrokerPayments(makeContainer(tg) as never)

    const last = tg.sendToAll.mock.calls.at(-1)![0] as string
    expect(last).toContain("Resolved")
    expect(last).toContain("#28413")
    expect(tg.rows.has(paidNoOrderKey(CART))).toBe(false)
  })

  it("stays quiet about carts it never alerted on", async () => {
    const tg = makeTg()
    await reconcileBrokerPayments(makeContainer(tg, { completedAt: "2026-08-08T11:59:00.000Z" }) as never)
    expect(tg.sendToAll).not.toHaveBeenCalled()
  })

  it("keeps the Sentry record every tick when Telegram is not configured", async () => {
    const tg = makeTg()
    tg.isConfigured.mockReturnValue(false)
    await reconcileBrokerPayments(makeContainer(tg) as never)
    jest.setSystemTime(new Date(TICK.getTime() + 5 * 60 * 1000))
    await reconcileBrokerPayments(makeContainer(tg) as never)

    expect(tg.sendToAll).not.toHaveBeenCalled()
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
  })

  it("never sends when the broker reports the payment is not paid", async () => {
    const tg = makeTg()
    mockGetPayment.mockResolvedValue({ ref: REF, status: "pending", amountMinor: 9000, currencyCode: "EUR" })
    await reconcileBrokerPayments(makeContainer(tg) as never)
    expect(tg.sendToAll).not.toHaveBeenCalled()
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })
})

describe("paid-but-no-order message building", () => {
  it("degrades to 'unknown' when the broker did not report an amount", () => {
    const text = buildPaidNoOrderAlert({ cartId: "cart_1", ref: "pay_1", amountMinor: null, currencyCode: null })
    expect(text).toContain("Amount: unknown")
  })

  it("renders a non-euro currency explicitly", () => {
    expect(
      buildPaidNoOrderAlert({ cartId: "c", ref: "r", amountMinor: 12345, currencyCode: "sek" })
    ).toContain("SEK 123.45")
  })

  it("escapes ids into the HTML parse mode", () => {
    expect(buildPaidNoOrderAlert({ cartId: "cart_<b>", ref: "r&r" })).toContain("cart_&lt;b&gt;")
    expect(buildPaidNoOrderResolved({ cartId: "cart_<b>" })).toContain("cart_&lt;b&gt;")
  })
})

describe("isPaidNoOrderAlertDue", () => {
  const now = new Date("2026-08-08T12:00:00.000Z")

  it("is due when nothing has been sent yet", () => {
    expect(isPaidNoOrderAlertDue(null, now)).toBe(true)
    expect(isPaidNoOrderAlertDue(undefined, now)).toBe(true)
  })

  it("is not due inside the repeat window", () => {
    expect(isPaidNoOrderAlertDue(new Date(now.getTime() - 59 * 60 * 1000), now)).toBe(false)
  })

  it("is due again once the window has passed", () => {
    expect(isPaidNoOrderAlertDue(new Date(now.getTime() - 61 * 60 * 1000), now)).toBe(true)
  })

  it("is due on an unreadable timestamp rather than silently swallowing the alert", () => {
    expect(isPaidNoOrderAlertDue("not a date", now)).toBe(true)
  })
})

describe("alerting must never break the recovery safety net", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(TICK)
    mockGetPayment.mockResolvedValue({ ref: REF, status: "captured", amountMinor: 9000, currencyCode: "EUR" })
    mockRunWorkflow.mockResolvedValue({ result: { id: "order_01JZ" }, errors: [] })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("still recovers the order when the resolve read blows up", async () => {
    const tg = makeTg()
    tg.findEvent.mockRejectedValue(new Error("db down"))
    await expect(reconcileBrokerPayments(makeContainer(tg, { completedAt: null }) as never)).resolves.toBeUndefined()
    expect(mockRunWorkflow).toHaveBeenCalled()
    expect(Sentry.captureException).toHaveBeenCalled()
  })
})
