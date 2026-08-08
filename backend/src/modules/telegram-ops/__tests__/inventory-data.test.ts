import { fetchInventoryRows, inventoryDisplayName } from '../commands/inventory-data'

// Live link shape: the link exposes the inventory item under `inventory`
// (graph path inventory_items.inventory.id | verified against prod).
const variant = (invId: string, productTitle: string, variantTitle: string, sku?: string) => ({
  id: `var_${invId}`,
  title: variantTitle,
  sku: sku ?? null,
  product: { title: productTitle },
  inventory_items: [{ inventory: { id: invId } }],
})

const invItem = (id: string, title: string, opts: Partial<{ sku: string; stocked: number; reserved: number }> = {}) => ({
  id, sku: opts.sku ?? null, title,
  location_levels: [{ location_id: 'sloc_1', stocked_quantity: opts.stocked ?? 10, reserved_quantity: opts.reserved ?? 2 }],
})

function makeContainer(inventory: unknown[], variants: unknown[]) {
  return {
    resolve: jest.fn((key: string) => {
      if (key === 'query') return {
        graph: jest.fn(async ({ entity }: { entity: string }) => ({
          data: entity === 'inventory_item' ? inventory : entity === 'product_variant' ? variants : [],
        })),
      }
      return undefined
    }),
  }
}

describe('fetchInventoryRows', () => {
  it('names rows via product + variant title, not the generic inventory title', async () => {
    const c = makeContainer(
      [invItem('iitem_1', '10mg Vial', { stocked: 6, reserved: 2 })],
      [variant('iitem_1', 'BPC-157', '10mg Vial')]
    )
    const rows = await fetchInventoryRows(c as never)
    expect(rows).toEqual([expect.objectContaining({
      id: 'iitem_1', name: 'BPC-157 10mg Vial', stocked: 6, reserved: 2, available: 4,
    })])
  })

  it('falls back to variant sku, then the inventory SKU before the packaging title', async () => {
    const c = makeContainer(
      [invItem('iitem_1', 'Bottle'), invItem('iitem_2', '10mg Vial', { sku: 'KPV-Vial-10MG' }), invItem('iitem_3', 'Vial')],
      [{ id: 'v1', title: null, sku: 'TB-500-5MG', product: null, inventory_items: [{ inventory: { id: 'iitem_1' } }] }]
    )
    const rows = await fetchInventoryRows(c as never)
    expect(rows.find((r) => r.id === 'iitem_1')!.name).toBe('TB-500-5MG')
    // Unlinked legacy item: the sku names the product, the title is packaging.
    expect(rows.find((r) => r.id === 'iitem_2')!.name).toBe('KPV-Vial-10MG')
    expect(rows.find((r) => r.id === 'iitem_3')!.name).toBe('Vial')
  })

  it('a failing variant lookup degrades to inventory titles instead of throwing', async () => {
    const query = {
      graph: jest.fn(async ({ entity }: { entity: string }) => {
        if (entity === 'product_variant') throw new Error('link down')
        return { data: [invItem('iitem_1', 'Vial')] }
      }),
    }
    const c = { resolve: jest.fn(() => query) }
    const rows = await fetchInventoryRows(c as never)
    expect(rows[0].name).toBe('Vial')
  })

  it('carries manage_inventory through as managed, and only an explicit boolean', async () => {
    const c = makeContainer(
      [invItem('iitem_on', 'Vial'), invItem('iitem_off', 'Vial'), invItem('iitem_missing', 'Vial'), invItem('iitem_unlinked', 'Vial')],
      [
        { ...variant('iitem_on', 'Managed', '10mg'), manage_inventory: true },
        { ...variant('iitem_off', 'Unmanaged', '10mg'), manage_inventory: false },
        // Field absent: query.graph returns undefined for an unknown field
        // name without erroring, so it must NOT read as "unmanaged".
        variant('iitem_missing', 'NoFlag', '10mg'),
      ]
    )
    const rows = await fetchInventoryRows(c as never)
    const managed = Object.fromEntries(rows.map((r) => [r.id, r.managed]))
    expect(managed).toEqual({
      iitem_on: true,
      iitem_off: false,
      iitem_missing: null,
      iitem_unlinked: null,
    })
  })

  it('skips the default-variant title suffix ("Default variant")', () => {
    expect(inventoryDisplayName({ product: { title: 'BPC-157' }, title: 'Default variant', sku: null } as never, 'Vial')).toBe('BPC-157')
    expect(inventoryDisplayName({ product: { title: 'BPC-157' }, title: '10mg', sku: null } as never, 'Vial')).toBe('BPC-157 10mg')
  })
})
