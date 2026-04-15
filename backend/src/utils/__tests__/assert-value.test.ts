import { assertValue } from '../assert-value'

describe('assertValue', () => {
  it('returns the value when a defined string is provided', () => {
    const result = assertValue('hello', 'should not throw')
    expect(result).toBe('hello')
  })

  it('returns an empty string when the value is empty but not undefined', () => {
    const result = assertValue('', 'should not throw')
    expect(result).toBe('')
  })

  it('throws an error with the provided message when the value is undefined', () => {
    expect(() => assertValue(undefined, 'Missing value')).toThrow('Missing value')
  })

  it('throws an instance of Error when the value is undefined', () => {
    expect(() => assertValue(undefined, 'boom')).toThrow(Error)
  })
})
