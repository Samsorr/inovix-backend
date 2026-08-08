import { stationCommand } from '../commands/station'

const paidPayment = {
  provider_id: 'pp_via_broker_via_broker',
  amount: 89.9,
  captures: [{ amount: 89.9 }],
  refunds: [],
  canceled_at: null,
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  display_id: 28412,
  status: 'pending',
  created_at: '2026-07-15T10:00:00Z',
  email: 'jan@x.nl',
  metadata: {},
  shipping_address: { first_name: 'Jan', last_name: 'Jansen' },
  items: [{ id: 'item_1', quantity: 2 }],
  fulfillments: [],
  payment_collections: [{ payments: [paidPayment] }],
  ...over,
})

const makeContainer = (rows: unknown[]) => ({
  resolve: jest.fn((key: string) => {
    if (key === 'query') return { graph: jest.fn().mockResolvedValue({ data: rows }) }
    return undefined
  }),
})

describe('stationCommand', () => {
  const svc = {} as never

  it('lists te verwerken and te verzenden queues', async () => {
    const rows = [
      row(), // paid, no fulfillment -> to_process
      row({ id: 'ord_2', display_id: 28413, fulfillments: [{ id: 'ful_1', packed_at: '2026-07-15T11:00:00Z', shipped_at: null, canceled_at: null }] }), // to_ship
      row({ id: 'ord_3', display_id: 28414, fulfillments: [{ id: 'ful_2', packed_at: 'x', shipped_at: 'y', canceled_at: null }] }), // shipped -> excluded
    ]
    const out = String(await stationCommand({ container: makeContainer(rows) as never, svc, chatId: '1', args: [] }))
    expect(out).toContain('To process (1)')
    expect(out).toContain('#28412')
    expect(out).toContain('Jan Jansen')
    expect(out).toContain('To ship (1)')
    expect(out).toContain('#28413')
    expect(out).not.toContain('#28414')
    expect(out).toContain('/order')
  })

  it('reports an empty station', async () => {
    const out = String(await stationCommand({ container: makeContainer([]) as never, svc, chatId: '1', args: [] }))
    expect(out).toContain('Nothing')
  })

  // The failure this guards against: an order with no Medusa capture row is in
  // neither work queue, so /station used to answer "All orders handled" while a
  // paid customer waited. Shape modelled on the live 2026-06-03 drift: a paid
  // broker payment with an empty captures array.
  it('surfaces an order that needs attention instead of claiming all are handled', async () => {
    const uncaptured = { ...paidPayment, captures: [] }
    const rows = [row({ payment_collections: [{ payments: [uncaptured] }] })]

    const out = String(await stationCommand({ container: makeContainer(rows) as never, svc, chatId: '1', args: [] }))

    expect(out).not.toContain('Nothing')
    expect(out).not.toContain('All orders handled')
    expect(out).toContain('Needs attention (1)')
    expect(out).toContain('#28412')
    expect(out).toContain('Jan Jansen')
    expect(out).toContain('Do not ship these until resolved.')
  })

  it('still says all handled when only shipped orders exist', async () => {
    const rows = [row({ fulfillments: [{ id: 'ful_1', packed_at: 'x', shipped_at: 'y', canceled_at: null }] })]
    const out = String(await stationCommand({ container: makeContainer(rows) as never, svc, chatId: '1', args: [] }))
    expect(out).toContain('Nothing')
  })
})
