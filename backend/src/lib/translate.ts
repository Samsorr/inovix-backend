import crypto from 'crypto'
import OpenAI from 'openai'
import { OPENAI_API_KEY, OPENAI_MODEL } from './constants'

// Languages we generate. All three are real targets: the source text in the DB
// is NOT reliably Dutch. The five spec/storage fields (FOREIGN_SOURCE_KEYS) are
// English by construction, and the prose fields (description/subtitle/
// long_description/category) are English for most of the live catalogue, so
// 'nl' has to be generated for them too or a Dutch visitor reads English.
// The DB source value is never overwritten; the storefront reads
// metadata.i18n.<locale> and falls back to the source.
export type TargetLang = 'nl' | 'de' | 'en'
export const TARGET_LANGS: TargetLang[] = ['nl', 'de', 'en']

export interface TranslatableFields {
  description?: string | null
  subtitle?: string | null
  long_description?: string | null // HTML (rich description from metadata)
  category?: string | null
  physical_state?: string | null
  solubility?: string | null
  shelf_life?: string | null
  storage_temp?: string | null
  handling_notes?: string | null
}

const FIELD_KEYS = [
  'description',
  'subtitle',
  'long_description',
  'category',
  'physical_state',
  'solubility',
  'shelf_life',
  'storage_temp',
  'handling_notes',
] as const

// Fields DECLARED to be English-authored: they are filled from supplier spec
// sheets and are never written in Dutch. They always get a Dutch rendering, no
// detection involved, so this path cannot regress on a short value the
// detector cannot read.
const FOREIGN_SOURCE_KEYS = [
  'physical_state',
  'solubility',
  'shelf_life',
  'storage_temp',
  'handling_notes',
] as const

// The prose fields. These have no declared source language: the catalogue is
// mixed (English for the products imported from the supplier copy, Dutch for
// anything the operator writes by hand), so their source language is detected
// per field. See dutchTargetFields.
const PROSE_KEYS = [
  'description',
  'subtitle',
  'long_description',
  'category',
] as const

// Per-field character caps. A field over its cap is skipped (the storefront
// falls back to the source for it) so a runaway paste can never produce an
// unbounded token bill. long_description is HTML and can legitimately be long,
// hence the larger budget; handling_notes is multi-paragraph prose.
const FIELD_LIMITS: Record<(typeof FIELD_KEYS)[number], number> = {
  description: 4_000,
  subtitle: 1_000,
  category: 200,
  long_description: 24_000,
  physical_state: 600,
  solubility: 300,
  shelf_life: 400,
  storage_temp: 200,
  handling_notes: 4_000,
}

// Hard ceiling on generated tokens per call (bounds cost + latency).
const MAX_OUTPUT_TOKENS = 8_000

const LANG_LABEL: Record<TargetLang, string> = {
  nl: 'Dutch (Nederlands)',
  de: "German (Deutsch), using the formal 'Sie' register",
  en: 'English',
}

// ---------------------------------------------------------------------------
// Source-language detection
// ---------------------------------------------------------------------------
// Used for one decision only: does this field still need a Dutch rendering, or
// is it already Dutch? Re-translating Dutch into Dutch burns tokens and lets
// the model rewrite copy the operator wrote on purpose.
//
// Deliberately a stopword count, not a library: it must be free, synchronous
// and deterministic (the alternative is an extra LLM round trip per field).

export type SourceLang = 'nl' | 'en' | 'unknown'

// Function words that are frequent in one language and are NOT a word in the
// other. Shared spellings ("in", "is", "of", "was", "over", "we", "die", "as",
// "per", "want", "na") are excluded on purpose, so a single ambiguous token can
// never flip the verdict.
const DUTCH_MARKERS = new Set([
  'de', 'het', 'een', 'en', 'van', 'voor', 'met', 'wordt', 'worden', 'zijn',
  'niet', 'bij', 'om', 'aan', 'door', 'ook', 'deze', 'dit', 'naar', 'tot',
  'uit', 'op', 'als', 'maar', 'meer', 'kan', 'kunnen', 'moet', 'wij', 'onze',
  'ons', 'hun', 'zoals', 'tussen', 'tijdens', 'gebruikt', 'gebruik', 'bewaren',
  'onderzoek', 'wetenschappelijk', 'kwaliteit', 'zuiverheid', 'alleen',
  'geleverd', 'hebben', 'heeft', 'bevat', 'hoge', 'elke', 'andere', 'veel',
  'geen', 'nog', 'dus', 'omdat', 'indien', 'vanaf', 'binnen', 'buiten',
  'onder', 'boven', 'zeer', 'zowel', 'echter', 'daarom', 'hierdoor',
])

const ENGLISH_MARKERS = new Set([
  'a', 'an', 'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those',
  'are', 'were', 'from', 'to', 'at', 'by', 'or', 'has', 'have', 'its', 'it',
  'our', 'you', 'your', 'they', 'their', 'which', 'when', 'where', 'while',
  'should', 'must', 'can', 'used', 'using', 'stored', 'storage', 'purity',
  'research', 'only', 'not', 'also', 'between', 'during', 'each', 'other',
  'more', 'than', 'into', 'within', 'such', 'there', 'been', 'being', 'after',
  'before', 'both', 'about', 'under', 'above', 'however', 'therefore',
])

// Below this many recognised markers the text is too short to judge (a
// subtitle like "5mg vial", a category like "Peptides").
const MIN_MARKERS = 2

function words(text: string): string[] {
  return text
    // long_description is HTML: drop tags and attributes before counting, or
    // "div", "class" and friends would be scored as prose.
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .toLowerCase()
    .split(/[^a-zàâäçéèêëîïôöùûüÿñæœßáíóúãõ]+/i)
    .filter(Boolean)
}

/**
 * Best-effort guess at the language a field was authored in.
 * Returns 'unknown' whenever the evidence is thin, and callers must treat
 * 'unknown' as "translate it" | a redundant translation costs tokens, a missed
 * one shows English to a Dutch buyer.
 */
export function detectSourceLang(text: string | null | undefined): SourceLang {
  if (typeof text !== 'string' || !text.trim()) return 'unknown'

  let nl = 0
  let en = 0
  for (const word of words(text)) {
    if (DUTCH_MARKERS.has(word)) nl++
    else if (ENGLISH_MARKERS.has(word)) en++
  }

  if (nl >= MIN_MARKERS && nl > en) return 'nl'
  if (en >= MIN_MARKERS && en > nl) return 'en'
  return 'unknown'
}

/**
 * The subset of `source` that needs a Dutch rendering generated.
 *
 * Two explicit rules, in this order:
 *  1. FOREIGN_SOURCE_KEYS (the five spec/storage fields) are DECLARED
 *     English-authored and are always included. No detection, so this path
 *     behaves exactly as it did before.
 *  2. The prose fields are included unless they are detected as already Dutch.
 *     Most of the live catalogue is English prose, so they normally are
 *     included; a hand-written Dutch description is left alone and the
 *     storefront falls back to the DB source for it.
 *
 * An operator who wants to force (or block) a field can still lock the
 * translations with metadata.i18n_locked.
 */
export function dutchTargetFields(source: TranslatableFields): TranslatableFields {
  const out: TranslatableFields = {}

  for (const key of FOREIGN_SOURCE_KEYS) {
    if (source[key] != null) out[key] = source[key]
  }

  for (const key of PROSE_KEYS) {
    const value = source[key]
    if (typeof value !== 'string' || !value.trim()) continue
    if (detectSourceLang(value) === 'nl') continue
    out[key] = value
  }

  return out
}

let client: OpenAI | null = null
function getClient(): OpenAI | null {
  if (!OPENAI_API_KEY) return null
  if (!client) {
    client = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 })
  }
  return client
}

/** True when an API key is present, so callers can no-op cleanly otherwise. */
export function translationConfigured(): boolean {
  return Boolean(OPENAI_API_KEY)
}

/**
 * Bump when the SHAPE of what we generate changes: a new target language, a
 * new field, or a different source-language rule. It is part of the source
 * hash, so every product's stored i18n_source_hash goes stale at once and the
 * next save (or the admin "Vertaal nu" button) regenerates instead of handing
 * back the cached translation. Nobody has to edit the product text to force it.
 *
 * v2 (2026-08-08): the Dutch pass now covers the prose fields, not just the
 * five English-authored spec fields.
 */
export const TRANSLATION_SCHEMA_VERSION = 2

// A stable hash of the source fields plus the generation schema version. The
// subscriber compares this against the last-translated hash so it only
// re-translates when the source (or the schema) actually changed, and so
// writing the translations back does not loop.
export function hashSource(source: TranslatableFields): string {
  const norm = JSON.stringify({
    v: TRANSLATION_SCHEMA_VERSION,
    d: source.description ?? '',
    s: source.subtitle ?? '',
    l: source.long_description ?? '',
    c: source.category ?? '',
    ps: source.physical_state ?? '',
    so: source.solubility ?? '',
    sl: source.shelf_life ?? '',
    st: source.storage_temp ?? '',
    hn: source.handling_notes ?? '',
  })
  return crypto.createHash('sha256').update(norm).digest('hex')
}

const SYSTEM_PROMPT = `You are a professional translator for an EU e-commerce store that sells research peptides for laboratory use. The source fields may be in Dutch or English. Translate the given product fields into {LANG}.

Rules:
- Translate ONLY natural-language prose. Keep these UNCHANGED in every field: the brand name "Inovix"; product and peptide names and codes (for example BPC-157, TB-500, GLP-1, GHK-Cu, Semaglutide); scientific abbreviations (HPLC, LC-MS, GC-MS, GMP, GLP, CoA, RUO, MS, SPPS); chemical formulas; CAS numbers; temperatures, units and numbers.
- "long_description" is HTML. Preserve ALL HTML tags, attributes and structure EXACTLY; translate only the human-readable text between the tags. Do not add, remove, or reorder tags.
- Keep a professional, scientific tone. For German use the formal "Sie".
- Keep the research-use meaning intact. Do not add disclaimers, notes, or commentary.
- Do not use em dashes; use commas, colons, or "|".
- Respond with a JSON object containing exactly the same keys you received, each holding the translated value.`

/**
 * Translate the non-empty fields of `source` into `lang`. Returns only the
 * fields that were present in the input. Throws if no API key is configured.
 */
export async function translateFields(
  source: TranslatableFields,
  lang: TargetLang
): Promise<TranslatableFields> {
  const api = getClient()
  if (!api) throw new Error('OPENAI_API_KEY not configured')

  const payload: Record<string, string> = {}
  for (const key of FIELD_KEYS) {
    const value = source[key]
    // Skip empty fields and anything over its cap (caps the token cost; an
    // oversized field just falls back to the Dutch source on the storefront).
    if (typeof value === 'string' && value.trim() && value.length <= FIELD_LIMITS[key]) {
      payload[key] = value
    }
  }
  if (Object.keys(payload).length === 0) return {}

  const completion = await api.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT.replace('{LANG}', LANG_LABEL[lang]) },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  })

  const raw = completion.choices[0]?.message?.content ?? '{}'
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = {}
  }

  const out: TranslatableFields = {}
  for (const key of FIELD_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Translate into every rendered language. Returns { nl, de, en }.
 * - de/en get every present field, whatever language it was written in.
 * - nl gets whatever `dutchTargetFields` says still needs Dutch: always the
 *   five English-authored spec fields, plus every prose field that is not
 *   already Dutch. A field left out simply falls back to the DB source on the
 *   Dutch storefront, which is correct precisely because it is already Dutch.
 *
 * Three OpenAI calls per product, unchanged | the nl call now carries more
 * fields rather than being an extra call.
 */
export async function translateAll(
  source: TranslatableFields
): Promise<Record<TargetLang, TranslatableFields>> {
  const [de, en, nl] = await Promise.all([
    translateFields(source, 'de'),
    translateFields(source, 'en'),
    translateFields(dutchTargetFields(source), 'nl'),
  ])

  return { nl, de, en }
}
