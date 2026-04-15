import type { MedusaRequest, MedusaResponse } from '@medusajs/framework'

// Mock Modules constant so req.scope.resolve receives a known key
jest.mock('@medusajs/framework/utils', () => ({
  Modules: { API_KEY: 'apiKeyModuleService' },
}))

import { GET } from '../route'

function mockRequest(overrides = {}) {
  return {
    scope: {
      resolve: jest.fn(),
    },
    ...overrides,
  } as unknown as MedusaRequest
}

function mockResponse() {
  const res: any = {}
  res.json = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.sendStatus = jest.fn().mockReturnValue(res)
  return res as MedusaResponse & { json: jest.Mock; status: jest.Mock; sendStatus: jest.Mock }
}

describe('GET /key-exchange', () => {
  it('returns publishableApiKey when a "Webshop" key exists', async () => {
    const req = mockRequest()
    const res = mockResponse()

    const apiKeyService = {
      listApiKeys: jest.fn().mockResolvedValue([
        { title: 'Webshop', token: 'pk_test_abc123' },
        { title: 'Other', token: 'pk_test_other' },
      ]),
    }
    ;(req.scope.resolve as jest.Mock).mockReturnValue(apiKeyService)

    await GET(req, res)

    expect(apiKeyService.listApiKeys).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ publishableApiKey: 'pk_test_abc123' })
  })

  it('returns an empty object when no "Webshop" key is found', async () => {
    const req = mockRequest()
    const res = mockResponse()

    const apiKeyService = {
      listApiKeys: jest.fn().mockResolvedValue([
        { title: 'Admin', token: 'pk_admin' },
      ]),
    }
    ;(req.scope.resolve as jest.Mock).mockReturnValue(apiKeyService)

    await GET(req, res)

    expect(res.json).toHaveBeenCalledWith({})
  })

  it('returns an empty object when the API key list is empty', async () => {
    const req = mockRequest()
    const res = mockResponse()

    const apiKeyService = {
      listApiKeys: jest.fn().mockResolvedValue([]),
    }
    ;(req.scope.resolve as jest.Mock).mockReturnValue(apiKeyService)

    await GET(req, res)

    expect(res.json).toHaveBeenCalledWith({})
  })

  it('returns 500 with the error message when the service throws', async () => {
    const req = mockRequest()
    const res = mockResponse()

    const apiKeyService = {
      listApiKeys: jest.fn().mockRejectedValue(new Error('Database connection failed')),
    }
    ;(req.scope.resolve as jest.Mock).mockReturnValue(apiKeyService)

    await GET(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Database connection failed' })
  })
})
