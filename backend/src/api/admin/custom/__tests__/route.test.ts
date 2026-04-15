import type { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { GET } from '../route'

function mockRequest() {
  return {} as unknown as MedusaRequest
}

function mockResponse() {
  const res: any = {}
  res.json = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.sendStatus = jest.fn().mockReturnValue(res)
  return res as MedusaResponse & { json: jest.Mock; status: jest.Mock; sendStatus: jest.Mock }
}

describe('GET /admin/custom', () => {
  it('returns 200 status', async () => {
    const req = mockRequest()
    const res = mockResponse()

    await GET(req, res)

    expect(res.sendStatus).toHaveBeenCalledWith(200)
  })
})
