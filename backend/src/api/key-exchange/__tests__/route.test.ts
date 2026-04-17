import type { MedusaRequest, MedusaResponse } from '@medusajs/framework'

// Mock Modules constant so req.scope.resolve receives a known key
jest.mock('@medusajs/framework/utils', () => ({
  Modules: { API_KEY: 'apiKeyModuleService' },
}))

import { GET } from '../route'

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}

function mockRequest(apiKeyService: unknown) {
  return {
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === 'logger') return mockLogger
        if (key === 'apiKeyModuleService') return apiKeyService
        return undefined
      }),
    },
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
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns publishableApiKey when a "Webshop" key exists', async () => {
    const apiKeyService = {
      listApiKeys: jest.fn().mockResolvedValue([
        { title: 'Webshop', token: 'pk_test_abc123' },
        { title: 'Other', token: 'pk_test_other' },
      ]),
    }
    const req = mockRequest(apiKeyService)
    const res = mockResponse()

    await GET(req, res)

    expect(apiKeyService.listApiKeys).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ publishableApiKey: 'pk_test_abc123' })
  })

  it('returns an empty object when no "Webshop" key is found', async () => {
    const apiKeyService = {
      listApiKeys: jest.fn().mockResolvedValue([
        { title: 'Admin', token: 'pk_admin' },
      ]),
    }
    const req = mockRequest(apiKeyService)
    const res = mockResponse()

    await GET(req, res)

    expect(res.json).toHaveBeenCalledWith({})
  })

  it('returns an empty object when the API key list is empty', async () => {
    const apiKeyService = {
      listApiKeys: jest.fn().mockResolvedValue([]),
    }
    const req = mockRequest(apiKeyService)
    const res = mockResponse()

    await GET(req, res)

    expect(res.json).toHaveBeenCalledWith({})
  })

  it('returns 500 with a generic message and logs the underlying error', async () => {
    const apiKeyService = {
      listApiKeys: jest.fn().mockRejectedValue(new Error('Database connection failed')),
    }
    const req = mockRequest(apiKeyService)
    const res = mockResponse()

    await GET(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    // Internal error details are not leaked to the client.
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to retrieve API key' })
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Database connection failed')
    )
  })
})
