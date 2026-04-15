jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bucketExists: jest.fn().mockResolvedValue(true),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    setBucketPolicy: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn().mockResolvedValue(undefined),
    removeObject: jest.fn().mockResolvedValue(undefined),
    presignedGetObject: jest.fn().mockResolvedValue('https://minio.example.com/presigned-url'),
    presignedPutObject: jest.fn().mockResolvedValue('https://minio.example.com/presigned-upload-url'),
    getObject: jest.fn(),
  })),
}), { virtual: true })

jest.mock('ulid', () => ({ ulid: jest.fn().mockReturnValue('01ABC123') }))

jest.mock('@medusajs/framework/utils', () => ({
  AbstractFileProviderService: class {},
  MedusaError: class MedusaError extends Error {
    static Types = { INVALID_DATA: 'invalid_data', UNEXPECTED_STATE: 'unexpected_state' }
    type: string
    constructor(type: string, message: string) {
      super(message)
      this.type = type
    }
  },
}))

import MinioFileProviderService from '../service'
import { Client } from 'minio'

const mockLogger = {
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

function createService(optionOverrides: Record<string, any> = {}) {
  const options = {
    endPoint: 'https://minio.example.com',
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    ...optionOverrides,
  }
  return new MinioFileProviderService({ logger: mockLogger as any }, options as any)
}

function getClientInstance(): any {
  const calls = (Client as unknown as jest.Mock).mock.calls
  const lastCall = calls[calls.length - 1]
  return lastCall[0] // constructor args
}

function getClientMock(): any {
  const results = (Client as unknown as jest.Mock).mock.results
  return results[results.length - 1].value
}

describe('MinioFileProviderService', () => {
  beforeEach(() => {
    ;(Client as unknown as jest.Mock).mockClear()
  })

  describe('validateOptions', () => {
    it('throws when endPoint is missing', () => {
      expect(() =>
        MinioFileProviderService.validateOptions({ accessKey: 'a', secretKey: 's' })
      ).toThrow("endPoint is required in the provider's options")
    })

    it('throws when accessKey is missing', () => {
      expect(() =>
        MinioFileProviderService.validateOptions({ endPoint: 'https://minio.example.com', secretKey: 's' })
      ).toThrow("accessKey is required in the provider's options")
    })

    it('throws when secretKey is missing', () => {
      expect(() =>
        MinioFileProviderService.validateOptions({ endPoint: 'https://minio.example.com', accessKey: 'a' })
      ).toThrow("secretKey is required in the provider's options")
    })

    it('passes with all required fields', () => {
      expect(() =>
        MinioFileProviderService.validateOptions({
          endPoint: 'https://minio.example.com',
          accessKey: 'a',
          secretKey: 's',
        })
      ).not.toThrow()
    })
  })

  describe('Constructor', () => {
    it('parses an https endpoint, strips the protocol, enables SSL, and uses port 443', () => {
      createService({ endPoint: 'https://minio.example.com' })

      const clientArgs = getClientInstance()
      expect(clientArgs.endPoint).toBe('minio.example.com')
      expect(clientArgs.useSSL).toBe(true)
      expect(clientArgs.port).toBe(443)
    })

    it('parses an http endpoint, strips the protocol, disables SSL, and uses port 80', () => {
      createService({ endPoint: 'http://minio.local' })

      const clientArgs = getClientInstance()
      expect(clientArgs.endPoint).toBe('minio.local')
      expect(clientArgs.useSSL).toBe(false)
      expect(clientArgs.port).toBe(80)
    })

    it('extracts a custom port from the endpoint', () => {
      createService({ endPoint: 'http://minio.local:9000' })

      const clientArgs = getClientInstance()
      expect(clientArgs.endPoint).toBe('minio.local')
      expect(clientArgs.port).toBe(9000)
    })

    it('uses the default bucket "medusa-media" when none is provided', () => {
      const service = createService({ bucket: undefined })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('medusa-media')
      )
    })

    it('uses a custom bucket when provided', () => {
      const service = createService({ bucket: 'custom-bucket' })

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('custom-bucket')
      )
    })
  })

  describe('upload', () => {
    it('generates a unique key with ULID, uploads to MinIO, and returns the URL and key', async () => {
      const service = createService()
      const client = getClientMock()

      const file = {
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        content: Buffer.from('fake-image-data'),
      }

      const result = await service.upload(file as any)

      expect(client.putObject).toHaveBeenCalledWith(
        'medusa-media',
        'photo-01ABC123.jpg',
        expect.any(Buffer),
        expect.any(Number),
        expect.objectContaining({ 'Content-Type': 'image/jpeg' })
      )
      expect(result.url).toBe('https://minio.example.com/medusa-media/photo-01ABC123.jpg')
      expect(result.key).toBe('photo-01ABC123.jpg')
    })

    it('handles base64 string content', async () => {
      const service = createService()
      const client = getClientMock()

      const base64Content = Buffer.from('hello').toString('base64')
      const file = {
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        content: base64Content,
      }

      const result = await service.upload(file as any)

      expect(client.putObject).toHaveBeenCalled()
      expect(result.key).toBe('document-01ABC123.pdf')
    })

    it('throws when no file is provided', async () => {
      const service = createService()

      await expect(service.upload(null as any)).rejects.toThrow('No file provided')
    })

    it('throws when no filename is provided', async () => {
      const service = createService()

      await expect(
        service.upload({ content: Buffer.from('data') } as any)
      ).rejects.toThrow('No filename provided')
    })

    it('throws when putObject fails', async () => {
      const service = createService()
      const client = getClientMock()
      client.putObject.mockRejectedValueOnce(new Error('Storage full'))

      const file = {
        filename: 'file.txt',
        mimeType: 'text/plain',
        content: Buffer.from('data'),
      }

      await expect(service.upload(file as any)).rejects.toThrow('Failed to upload file: Storage full')
    })
  })

  describe('delete', () => {
    it('removes a single file from the bucket', async () => {
      const service = createService()
      const client = getClientMock()

      await service.delete({ fileKey: 'photo-01ABC123.jpg' } as any)

      expect(client.removeObject).toHaveBeenCalledWith('medusa-media', 'photo-01ABC123.jpg')
    })

    it('removes an array of files', async () => {
      const service = createService()
      const client = getClientMock()

      await service.delete([
        { fileKey: 'file1.jpg' },
        { fileKey: 'file2.jpg' },
      ] as any)

      expect(client.removeObject).toHaveBeenCalledTimes(2)
      expect(client.removeObject).toHaveBeenCalledWith('medusa-media', 'file1.jpg')
      expect(client.removeObject).toHaveBeenCalledWith('medusa-media', 'file2.jpg')
    })

    it('warns but does not throw when removeObject fails', async () => {
      const service = createService()
      const client = getClientMock()
      client.removeObject.mockRejectedValueOnce(new Error('Network error'))

      await expect(
        service.delete({ fileKey: 'photo.jpg' } as any)
      ).resolves.toBeUndefined()

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete file photo.jpg')
      )
    })

    it('throws when no fileKey is provided', async () => {
      const service = createService()

      await expect(service.delete({ fileKey: '' } as any)).rejects.toThrow(
        'No file key provided'
      )
    })

    it('throws when fileKey is undefined', async () => {
      const service = createService()

      await expect(service.delete({} as any)).rejects.toThrow(
        'No file key provided'
      )
    })
  })

  describe('getPresignedDownloadUrl', () => {
    it('returns a presigned URL with 24-hour expiry', async () => {
      const service = createService()
      const client = getClientMock()

      const url = await service.getPresignedDownloadUrl({ fileKey: 'photo.jpg' } as any)

      expect(client.presignedGetObject).toHaveBeenCalledWith(
        'medusa-media',
        'photo.jpg',
        24 * 60 * 60
      )
      expect(url).toBe('https://minio.example.com/presigned-url')
    })

    it('throws when no fileKey is provided', async () => {
      const service = createService()

      await expect(
        service.getPresignedDownloadUrl({} as any)
      ).rejects.toThrow('No file key provided')
    })

    it('throws when fileData is null', async () => {
      const service = createService()

      await expect(
        service.getPresignedDownloadUrl(null as any)
      ).rejects.toThrow('No file key provided')
    })
  })

  describe('getPresignedUploadUrl', () => {
    it('returns a presigned URL with the filename as the key', async () => {
      const service = createService()
      const client = getClientMock()

      const result = await service.getPresignedUploadUrl({ filename: 'upload.png' } as any)

      expect(client.presignedPutObject).toHaveBeenCalledWith(
        'medusa-media',
        'upload.png',
        15 * 60
      )
      expect(result.url).toBe('https://minio.example.com/presigned-upload-url')
      expect(result.key).toBe('upload.png')
    })

    it('throws when no filename is provided', async () => {
      const service = createService()

      await expect(
        service.getPresignedUploadUrl({} as any)
      ).rejects.toThrow('No filename provided')
    })

    it('throws when fileData is null', async () => {
      const service = createService()

      await expect(
        service.getPresignedUploadUrl(null as any)
      ).rejects.toThrow('No filename provided')
    })
  })
})
