import { runStockWatch } from '../telegram-stock-watch'

const invItem = (id: string, title: string, stocked: number, reserved: number) => ({
  id, sku: title, title,
  location_levels: [{ location_id: 'sloc_1', stocked_quantity: stocked, reserved_quantity: reserved }],
})

// The variant row that carries the manage_inventory flag. Live graph path is
// inventory_items.inventory.id (the flat form resolves to undefined silently).
const variantFor = (invId: string, productTitle: string, managed: boolean | null | undefined) => ({
  id: `var_${invId}`,
  title: 'Default variant',
  sku: null,
  ...(managed === undefined ? {} : { manage_inventory: managed }),
  product: { title: productTitle },
  inventory_items: [{ inventory: { id: invId } }],
})

function makeContainer(
  inventory: unknown[],
  states: Record<string, { state: string }> = {},
  variants: unknown[] = []
) {
  // In-memory event-log rows keyed by event key.
  const rows = new Map(Object.entries(states).map(([k, p]) => [k, { id: `evt_${k}`, key: k, kind: 'stock_state', payload: p }]))
  const svc = {
    isConfigured: jest.fn(() => true),
    sendToAll: jest.fn().mockResolvedValue(undefined),
    findEvent: jest.fn(async (key: string) => rows.get(key) ?? null),
    touchEvent: jest.fn(async (key: string, kind: string, data: { payload?: { state: string } }) => {
      rows.set(key, { id: `evt_${key}`, key, kind, payload: data.payload as never })
    }),
    releaseAction: jest.fn(async (key: string) => { rows.delete(key) }),
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return {
    svc, rows, logger,
    resolve: jest.fn((key: string) => {
      if (key === 'telegram_ops') return svc
      if (key === 'query') return {
        graph: jest.fn(async ({ entity }: { entity: string }) => ({
          data: entity === 'product_variant' ? variants : inventory,
        })),
      }
      if (key === 'logger') return logger
      return undefined
    }),
  }
}

describe('runStockWatch', () => {
  beforeEach(() => { delete process.env.OPS_LOW_STOCK_THRESHOLD })

  it('N7 on ok->low crossing, with Restock/Stock buttons, once', async () => {
    const c = makeContainer([invItem('iitem_1', 'BPC-157 10mg', 6, 2)]) // available 4 <= 5
    await runStockWatch(c as never)
    expect(c.svc.sendToAll).toHaveBeenCalledTimes(1)
    const [text, extra] = c.svc.sendToAll.mock.calls[0]
    expect(text).toContain('Low stock')
    expect(text).toContain('4 left')
    expect(JSON.stringify(extra)).toContain('rsk:iitem_1')
    expect(JSON.stringify(extra)).toContain('stk')
    // second run: state stored, no new alert
    await runStockWatch(c as never)
    expect(c.svc.sendToAll).toHaveBeenCalledTimes(1)
  })

  it('N8 on ok->oos, and low->oos escalates', async () => {
    const oos = makeContainer([invItem('iitem_1', 'X', 2, 2)]) // available 0
    await runStockWatch(oos as never)
    expect(oos.svc.sendToAll.mock.calls[0][0]).toContain('OUT of stock')

    const escalate = makeContainer([invItem('iitem_1', 'X', 2, 2)], { 'tg-stockstate-iitem_1': { state: 'low' } })
    await runStockWatch(escalate as never)
    expect(escalate.svc.sendToAll.mock.calls[0][0]).toContain('OUT of stock')
  })

  it('recovery above the threshold deletes the state row (re-arms)', async () => {
    const c = makeContainer([invItem('iitem_1', 'X', 50, 0)], { 'tg-stockstate-iitem_1': { state: 'low' } })
    await runStockWatch(c as never)
    expect(c.svc.sendToAll).not.toHaveBeenCalled()
    expect(c.svc.releaseAction).toHaveBeenCalledWith('tg-stockstate-iitem_1')
  })

  it('does nothing when the bot is unconfigured', async () => {
    const c = makeContainer([invItem('iitem_1', 'X', 0, 0)])
    c.svc.isConfigured.mockReturnValue(false)
    await runStockWatch(c as never)
    expect(c.svc.sendToAll).not.toHaveBeenCalled()
  })

  it('does not escape the plain-text Restock button label', async () => {
    // Button text is not parsed as HTML: escaping renders a literal "A&amp;B",
    // and slicing after escaping can cut an entity in half.
    const c = makeContainer([invItem('iitem_1', 'A&B', 0, 0)], {}, [variantFor('iitem_1', 'A&B', true)])
    await runStockWatch(c as never)
    expect(JSON.stringify(c.svc.sendToAll.mock.calls[0][1])).toContain('Restock A&B')
  })

  describe('manage_inventory=false (the numbers cannot move)', () => {
    it('does not claim PT-141 is OUT of stock while the site still sells it', async () => {
      // PT-141: stocked 0, manage_inventory off. Medusa skips it in every
      // stock gate, so inovix.nl shows a green "Op voorraad" dot and takes the
      // order. "OUT of stock on site" is simply false.
      const c = makeContainer(
        [invItem('iitem_pt141', 'PT-141-Vial-10mg', 0, 0)],
        {},
        [variantFor('iitem_pt141', 'PT-141', false)]
      )
      await runStockWatch(c as never)
      expect(c.svc.sendToAll).not.toHaveBeenCalled()
      expect(c.svc.touchEvent).not.toHaveBeenCalled()
    })

    it('does not fire a low-stock alert it could never repeat either', async () => {
      // Adamax: 2 on the shelf and dropping in the real world, but the number
      // is frozen, so a "low stock" crossing here is meaningless.
      const c = makeContainer(
        [invItem('iitem_adamax', 'Admax-Spray-10mg', 2, 0)],
        {},
        [variantFor('iitem_adamax', 'Adamax', false)]
      )
      await runStockWatch(c as never)
      expect(c.svc.sendToAll).not.toHaveBeenCalled()
    })

    it('reports the skipped items in the log, and leaves the alert to check-variant-inventory-levels', async () => {
      const c = makeContainer(
        [invItem('iitem_pt141', 'PT-141-Vial-10mg', 0, 0)],
        {},
        [variantFor('iitem_pt141', 'PT-141', false)]
      )
      await runStockWatch(c as never)
      const logged = c.logger.info.mock.calls.map((a: unknown[]) => String(a[0])).join('\n')
      expect(logged).toContain('PT-141')
      expect(logged).toContain('manage_inventory=false')
    })

    it('clears stale crossing state so switching the flag back on re-arms cleanly', async () => {
      const c = makeContainer(
        [invItem('iitem_1', 'X', 0, 0)],
        { 'tg-stockstate-iitem_1': { state: 'oos' } },
        [variantFor('iitem_1', 'X', false)]
      )
      await runStockWatch(c as never)
      expect(c.svc.releaseAction).toHaveBeenCalledWith('tg-stockstate-iitem_1')
      expect(c.svc.sendToAll).not.toHaveBeenCalled()
    })

    it('still alerts for a managed variant and for an unknown flag', async () => {
      // managed=true alerts as before; an item with no variant link (13 legacy
      // rows) or a failed lookup is `null`, NOT false, so it keeps the old
      // behaviour rather than silencing the channel.
      const c = makeContainer(
        [invItem('iitem_managed', 'M', 0, 0), invItem('iitem_orphan', 'O', 0, 0)],
        {},
        [variantFor('iitem_managed', 'Managed', true)]
      )
      await runStockWatch(c as never)
      expect(c.svc.sendToAll).toHaveBeenCalledTimes(2)
    })

    it('treats a missing manage_inventory field as unknown, not as false', async () => {
      // query.graph returns undefined for a field name it does not know,
      // silently. Reading that as "unmanaged" would mute every alert at once.
      const c = makeContainer(
        [invItem('iitem_1', 'X', 0, 0)],
        {},
        [variantFor('iitem_1', 'X', undefined)]
      )
      await runStockWatch(c as never)
      expect(c.svc.sendToAll).toHaveBeenCalledTimes(1)
    })
  })
})
