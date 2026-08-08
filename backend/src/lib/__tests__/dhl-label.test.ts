import { createDhlLabelForOrder } from '../dhl-label'

jest.mock('../../workflows/create-dhl-parcel-shipment', () => ({
  createDhlParcelShipmentWorkflow: jest.fn(),
}))
jest.mock('../../api/admin/orders/[id]/payment/resolve', () => ({
  resolveBrokerPayment: jest.fn().mockResolvedValue({ id: 'pay_1' }),
}))
jest.mock('../instrument', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}))
import { createDhlParcelShipmentWorkflow } from '../../workflows/create-dhl-parcel-shipment'

const tickedChecklist = (itemIds: string[]) => ({
  fulfillment_checklist: {
    version: 1,
    items: Object.fromEntries(itemIds.map((id) => [id, { at: '2026-07-15T10:00:00Z', by_id: 'u1', by_name: 'Sam' }])),
    package_closed: null,
    overrides: [],
  },
})

function makeContainer(order: unknown) {
  const query = { graph: jest.fn().mockResolvedValue({ data: order ? [order] : [] }) }
  const orderService = {
    updateOrders: jest.fn().mockResolvedValue({}),
    // The override path goes through lib/fulfillment-checklist-write.ts,
    // which re-reads the order via the order module inside the write queue.
    retrieveOrder: jest.fn(async () => ({ id: 'ord_1', metadata: (order as { metadata?: unknown })?.metadata ?? {} })),
  }
  const tg = { notify: jest.fn().mockResolvedValue(true) }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return {
    query, orderService, tg, logger,
    resolve: jest.fn((key: string) => {
      if (key === 'query') return query
      if (key === 'order') return orderService
      if (key === 'telegram_ops') return tg
      if (key === 'logger') return logger
      return undefined
    }),
  }
}

const baseOrder = {
  id: 'ord_1', display_id: 28412, status: 'pending', email: 'x@y.z',
  metadata: tickedChecklist(['item_1']),
  items: [{ id: 'item_1', variant: { product: { weight: '20' } } }],
  shipping_methods: [{ id: 'sm_1', data: { dhl_option: 'DOOR' } }],
  fulfillments: [],
  shipping_address: { country_code: 'nl' },
}

describe('createDhlLabelForOrder', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns not_found for a missing order', async () => {
    const c = makeContainer(null)
    await expect(createDhlLabelForOrder(c as never, 'ord_x')).resolves.toEqual({ status: 'not_found' })
  })

  it('returns exists (and notifies N5) for an order that already has a live DHL label', async () => {
    const order = {
      ...baseOrder,
      fulfillments: [{ id: 'ful_1', provider_id: 'dhl-parcel_dhl-parcel', canceled_at: null,
        data: { dhl_tracking_number: '3S1' }, labels: [{ tracking_number: '3S1' }] }],
    }
    const c = makeContainer(order)
    const r = await createDhlLabelForOrder(c as never, 'ord_1')
    expect(r).toMatchObject({ status: 'exists', fulfillment_id: 'ful_1', tracking_number: '3S1', display_id: 28412 })
    expect(c.tg.notify).toHaveBeenCalledWith('tg-label-ful_1', 'label_created', expect.stringContaining('28412'), expect.anything())
    expect(createDhlParcelShipmentWorkflow).not.toHaveBeenCalled()
  })

  it('blocks on an unticked checklist without an override', async () => {
    const order = { ...baseOrder, metadata: {} }
    const c = makeContainer(order)
    await expect(createDhlLabelForOrder(c as never, 'ord_1')).resolves.toEqual({
      status: 'checklist_blocked', order_id: 'ord_1', display_id: 28412, ticked: 0, total: 1,
    })
    expect(createDhlParcelShipmentWorkflow).not.toHaveBeenCalled()
  })

  it('itemsOverride writes the override to metadata and proceeds', async () => {
    const order = { ...baseOrder, metadata: {} }
    const run = jest.fn().mockResolvedValue({ result: {
      fulfillment_id: 'ful_2',
      fulfillment: { data: { dhl_tracking_number: '3S2', dhl_label_pdf_url: 'u', dhl_shipment_tracking_url: 't' } },
    } })
    ;(createDhlParcelShipmentWorkflow as jest.Mock).mockReturnValue({ run })
    const c = makeContainer(order)
    const r = await createDhlLabelForOrder(c as never, 'ord_1', {
      itemsOverride: { byId: 'tg:8842061517', byName: 'Sam', reason: 'Label aangemaakt via Telegram-bot door Sam' },
    })
    expect(r).toMatchObject({ status: 'created', fulfillment_id: 'ful_2', tracking_number: '3S2' })
    expect(c.orderService.updateOrders).toHaveBeenCalledWith([expect.objectContaining({
      id: 'ord_1',
      metadata: expect.objectContaining({
        fulfillment_checklist: expect.objectContaining({
          overrides: [expect.objectContaining({ step: 'items', by_name: 'Sam' })],
        }),
      }),
    })])
  })

  it('creates the label when the checklist is complete', async () => {
    const run = jest.fn().mockResolvedValue({ result: {
      fulfillment_id: 'ful_3', fulfillment: { data: { dhl_tracking_number: '3S3' } },
    } })
    ;(createDhlParcelShipmentWorkflow as jest.Mock).mockReturnValue({ run })
    const c = makeContainer(baseOrder)
    const r = await createDhlLabelForOrder(c as never, 'ord_1')
    expect(r).toMatchObject({ status: 'created', tracking_number: '3S3', display_id: 28412 })
    expect(c.orderService.updateOrders).not.toHaveBeenCalled()
    expect(c.tg.notify).toHaveBeenCalledWith('tg-label-ful_3', 'label_created', expect.stringContaining('Label ready'), expect.anything())
  })

  it('N5 notify carries the Mark-shipped + Details keyboard', async () => {
    const run = jest.fn().mockResolvedValue({ result: {
      fulfillment_id: 'ful_9', fulfillment: { data: { dhl_tracking_number: '3S9' } },
    } })
    ;(createDhlParcelShipmentWorkflow as jest.Mock).mockReturnValue({ run })
    const c = makeContainer(baseOrder)
    await createDhlLabelForOrder(c as never, 'ord_1')
    const extra = c.tg.notify.mock.calls[0][3]
    const kb = JSON.stringify(extra)
    expect(kb).toContain('shp:ord_1:28412')
    expect(kb).toContain('det:28412')
  })

  it('clears a stale package_closed tick when a label is redone after a cancel', async () => {
    // The previous label was canceled, so the box was opened again. The old
    // "pakket dicht" tick must not carry over to the new label, or step 4 shows
    // green for a package that no longer exists.
    const order = {
      ...baseOrder,
      metadata: {
        fulfillment_checklist: {
          version: 1,
          items: { item_1: { at: '2026-07-15T10:00:00Z', by_id: 'u1', by_name: 'Sam' } },
          package_closed: { at: '2026-07-15T10:05:00Z', by_id: 'u1', by_name: 'Sam' },
          overrides: [],
        },
      },
      fulfillments: [
        { id: 'ful_old', provider_id: 'dhl-parcel_dhl-parcel', canceled_at: '2026-07-15T11:00:00Z',
          data: { dhl_tracking_number: '3S0' }, labels: [{ tracking_number: '3S0' }] },
      ],
    }
    const run = jest.fn().mockResolvedValue({ result: {
      fulfillment_id: 'ful_4', fulfillment: { data: { dhl_tracking_number: '3S4' } },
    } })
    ;(createDhlParcelShipmentWorkflow as jest.Mock).mockReturnValue({ run })
    const c = makeContainer(order)

    const r = await createDhlLabelForOrder(c as never, 'ord_1')

    expect(r).toMatchObject({ status: 'created', fulfillment_id: 'ful_4' })
    expect(c.orderService.updateOrders).toHaveBeenCalledWith([expect.objectContaining({
      id: 'ord_1',
      metadata: expect.objectContaining({
        fulfillment_checklist: expect.objectContaining({ package_closed: null }),
      }),
    })])
  })

  it('leaves the checklist alone on a first label attempt', async () => {
    const run = jest.fn().mockResolvedValue({ result: {
      fulfillment_id: 'ful_5', fulfillment: { data: { dhl_tracking_number: '3S5' } },
    } })
    ;(createDhlParcelShipmentWorkflow as jest.Mock).mockReturnValue({ run })
    const c = makeContainer(baseOrder)
    await createDhlLabelForOrder(c as never, 'ord_1')
    expect(c.orderService.updateOrders).not.toHaveBeenCalled()
  })

  it('maps a workflow MedusaError to invalid with an http status', async () => {
    const medusaErr = Object.assign(new Error('De betaling is nog niet (volledig) ontvangen'), {
      __isMedusaError: true, type: 'not_allowed',
    })
    const run = jest.fn().mockRejectedValue(medusaErr)
    ;(createDhlParcelShipmentWorkflow as jest.Mock).mockReturnValue({ run })
    const c = makeContainer(baseOrder)
    const r = await createDhlLabelForOrder(c as never, 'ord_1')
    expect(r).toMatchObject({ status: 'invalid', httpStatus: 400 })
  })
})
