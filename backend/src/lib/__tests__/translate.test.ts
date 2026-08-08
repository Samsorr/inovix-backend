import crypto from 'crypto'

const mockCreate = jest.fn()

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}))

jest.mock('../constants', () => ({
  OPENAI_API_KEY: 'test-key',
  OPENAI_MODEL: 'gpt-4o-mini',
}))

import {
  TARGET_LANGS,
  TRANSLATION_SCHEMA_VERSION,
  detectSourceLang,
  dutchTargetFields,
  hashSource,
  translateAll,
  type TranslatableFields,
} from '../translate'

// Real catalogue shapes: the live products carry ENGLISH prose plus the five
// English spec fields. The Dutch samples are what an operator writes by hand.
const ENGLISH_DESCRIPTION =
  'BPC-157 is a stable gastric pentadecapeptide supplied as a lyophilized powder for laboratory research. Each vial is analysed by HPLC and shipped with a certificate of analysis.'
const DUTCH_DESCRIPTION =
  'BPC-157 is een stabiel gastrisch pentadecapeptide dat wordt geleverd als gevriesdroogd poeder voor laboratoriumonderzoek. Elke flacon wordt door HPLC geanalyseerd en met een analysecertificaat verzonden.'

const ENGLISH_SOURCE: TranslatableFields = {
  description: ENGLISH_DESCRIPTION,
  subtitle: '5mg vial',
  long_description:
    '<div class="prose"><h2>Storage and handling</h2><p>Store the lyophilized powder at -20 &deg;C and protect it from light. Reconstituted material should be used within the stated period.</p></div>',
  category: 'Peptides',
  physical_state: 'Lyophilized white powder',
  solubility: 'Soluble in bacteriostatic water',
  shelf_life: '24 months at -20 degrees Celsius',
  storage_temp: '-20 degrees Celsius',
  handling_notes: 'Handle with gloves. Avoid repeated freeze-thaw cycles.',
}

function langOf(systemPrompt: string): 'nl' | 'de' | 'en' | 'other' {
  if (systemPrompt.includes('Dutch (Nederlands)')) return 'nl'
  if (systemPrompt.includes('German (Deutsch)')) return 'de'
  if (systemPrompt.includes('into English')) return 'en'
  return 'other'
}

function payloadFor(lang: 'nl' | 'de' | 'en'): Record<string, string> | null {
  for (const call of mockCreate.mock.calls) {
    const messages = call[0].messages as { role: string; content: string }[]
    if (langOf(messages[0].content) !== lang) continue
    return JSON.parse(messages[1].content) as Record<string, string>
  }
  return null
}

beforeEach(() => {
  mockCreate.mockImplementation(async () => ({
    choices: [{ message: { content: '{}' } }],
  }))
})

// ---------------------------------------------------------------------------

describe('detectSourceLang', () => {
  it('reads English prose as English', () => {
    expect(detectSourceLang(ENGLISH_DESCRIPTION)).toBe('en')
  })

  it('reads Dutch prose as Dutch', () => {
    expect(detectSourceLang(DUTCH_DESCRIPTION)).toBe('nl')
  })

  it('counts only the text of an HTML field, not its tags and attributes', () => {
    const html =
      '<div class="prose"><p>Deze stof wordt bewaard bij -20 graden en is alleen voor onderzoek.</p></div>'
    expect(detectSourceLang(html)).toBe('nl')
  })

  it('is not fooled by HTML markup into calling Dutch text English', () => {
    const html =
      '<section><ul><li>Elke flacon wordt geleverd met een analysecertificaat</li></ul></section>'
    expect(detectSourceLang(html)).toBe('nl')
  })

  it('returns unknown when the text is too short to judge', () => {
    expect(detectSourceLang('5mg')).toBe('unknown')
    expect(detectSourceLang('Peptides')).toBe('unknown')
    expect(detectSourceLang('BPC-157')).toBe('unknown')
  })

  it('returns unknown for empty / missing input', () => {
    expect(detectSourceLang('')).toBe('unknown')
    expect(detectSourceLang('   ')).toBe('unknown')
    expect(detectSourceLang(null)).toBe('unknown')
    expect(detectSourceLang(undefined)).toBe('unknown')
  })
})

describe('dutchTargetFields', () => {
  it('sends the English prose fields to the Dutch pass', () => {
    const target = dutchTargetFields(ENGLISH_SOURCE)
    expect(target.description).toBe(ENGLISH_DESCRIPTION)
    expect(target.long_description).toBe(ENGLISH_SOURCE.long_description)
    expect(target.subtitle).toBe('5mg vial')
    expect(target.category).toBe('Peptides')
  })

  it('keeps all five English-authored spec fields (the behaviour that already worked)', () => {
    const target = dutchTargetFields(ENGLISH_SOURCE)
    expect(target.physical_state).toBe('Lyophilized white powder')
    expect(target.solubility).toBe('Soluble in bacteriostatic water')
    expect(target.shelf_life).toBe('24 months at -20 degrees Celsius')
    expect(target.storage_temp).toBe('-20 degrees Celsius')
    expect(target.handling_notes).toBe(
      'Handle with gloves. Avoid repeated freeze-thaw cycles.'
    )
  })

  it('leaves a Dutch-authored prose field alone', () => {
    const target = dutchTargetFields({
      ...ENGLISH_SOURCE,
      description: DUTCH_DESCRIPTION,
    })
    expect(target.description).toBeUndefined()
    // the rest of the product is untouched by that decision
    expect(target.long_description).toBe(ENGLISH_SOURCE.long_description)
    expect(target.physical_state).toBe('Lyophilized white powder')
  })

  it('keeps the spec fields even when they read as Dutch (declared, not detected)', () => {
    const target = dutchTargetFields({
      physical_state: 'Gevriesdroogd wit poeder dat onder -20 graden wordt bewaard',
    })
    expect(target.physical_state).toBe(
      'Gevriesdroogd wit poeder dat onder -20 graden wordt bewaard'
    )
  })

  it('translates when the language cannot be determined (missing beats redundant)', () => {
    const target = dutchTargetFields({ subtitle: '5mg vial', category: 'Peptides' })
    expect(target.subtitle).toBe('5mg vial')
    expect(target.category).toBe('Peptides')
  })

  it('skips empty and missing fields', () => {
    const target = dutchTargetFields({
      description: '',
      subtitle: '   ',
      category: null,
    })
    expect(target).toEqual({})
  })
})

describe('hashSource', () => {
  it('is stable for the same input', () => {
    expect(hashSource(ENGLISH_SOURCE)).toBe(hashSource(ENGLISH_SOURCE))
  })

  it('changes when the source text changes', () => {
    expect(hashSource({ ...ENGLISH_SOURCE, description: 'other' })).not.toBe(
      hashSource(ENGLISH_SOURCE)
    )
  })

  it('is versioned, so the v1 hashes stored on live products are stale', () => {
    // Exactly what v1 hashed: the same fields, no version key.
    const v1 = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          d: ENGLISH_SOURCE.description ?? '',
          s: ENGLISH_SOURCE.subtitle ?? '',
          l: ENGLISH_SOURCE.long_description ?? '',
          c: ENGLISH_SOURCE.category ?? '',
          ps: ENGLISH_SOURCE.physical_state ?? '',
          so: ENGLISH_SOURCE.solubility ?? '',
          sl: ENGLISH_SOURCE.shelf_life ?? '',
          st: ENGLISH_SOURCE.storage_temp ?? '',
          hn: ENGLISH_SOURCE.handling_notes ?? '',
        })
      )
      .digest('hex')
    expect(hashSource(ENGLISH_SOURCE)).not.toBe(v1)
    expect(TRANSLATION_SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
  })
})

describe('translateAll', () => {
  it('declares all three languages as real targets', () => {
    expect(TARGET_LANGS).toEqual(['nl', 'de', 'en'])
  })

  it('runs a Dutch pass that includes the prose fields for an English product', async () => {
    await translateAll(ENGLISH_SOURCE)

    const nl = payloadFor('nl')
    expect(nl).not.toBeNull()
    expect(nl!.description).toBe(ENGLISH_DESCRIPTION)
    expect(nl!.long_description).toBe(ENGLISH_SOURCE.long_description)
    expect(nl!.subtitle).toBe('5mg vial')
    expect(nl!.category).toBe('Peptides')
  })

  it('still sends the five spec fields in the Dutch pass', async () => {
    await translateAll(ENGLISH_SOURCE)

    const nl = payloadFor('nl')!
    expect(nl.physical_state).toBe('Lyophilized white powder')
    expect(nl.solubility).toBe('Soluble in bacteriostatic water')
    expect(nl.shelf_life).toBe('24 months at -20 degrees Celsius')
    expect(nl.storage_temp).toBe('-20 degrees Celsius')
    expect(nl.handling_notes).toBe(
      'Handle with gloves. Avoid repeated freeze-thaw cycles.'
    )
  })

  it('sends every field to de and en regardless of source language', async () => {
    await translateAll({ ...ENGLISH_SOURCE, description: DUTCH_DESCRIPTION })

    for (const lang of ['de', 'en'] as const) {
      const payload = payloadFor(lang)!
      expect(payload.description).toBe(DUTCH_DESCRIPTION)
      expect(payload.physical_state).toBe('Lyophilized white powder')
    }
  })

  it('omits an already-Dutch description from the Dutch pass', async () => {
    await translateAll({ ...ENGLISH_SOURCE, description: DUTCH_DESCRIPTION })

    const nl = payloadFor('nl')!
    expect(nl.description).toBeUndefined()
    expect(nl.long_description).toBe(ENGLISH_SOURCE.long_description)
  })

  it('costs three OpenAI calls, the same as before', async () => {
    await translateAll(ENGLISH_SOURCE)
    expect(mockCreate).toHaveBeenCalledTimes(3)
  })

  it('skips the Dutch call entirely when nothing needs Dutch', async () => {
    await translateAll({ description: DUTCH_DESCRIPTION })
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(payloadFor('nl')).toBeNull()
  })

  it('returns the model output under nl, de and en', async () => {
    mockCreate.mockImplementation(async (args: { messages: { content: string }[] }) => {
      const lang = langOf(args.messages[0].content)
      return {
        choices: [
          { message: { content: JSON.stringify({ description: `${lang}-text` }) } },
        ],
      }
    })

    const result = await translateAll(ENGLISH_SOURCE)
    expect(result.nl.description).toBe('nl-text')
    expect(result.de.description).toBe('de-text')
    expect(result.en.description).toBe('en-text')
  })
})
