import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import type { IProductModuleService } from '@medusajs/framework/types'
import { OPENAI_MODEL } from '../lib/constants'
import {
  translationConfigured,
  translateAll,
  hashSource,
  type TranslatableFields,
} from '../lib/translate'

/**
 * Backfill the Dutch product prose that existing products can never receive
 * on their own.
 *
 *   # list what would be translated, calls nothing, costs nothing:
 *   medusa exec ./src/scripts/backfill-nl-translations.ts
 *
 *   # actually translate and write:
 *   BACKFILL_NL_APPLY=1 medusa exec ./src/scripts/backfill-nl-translations.ts
 *
 * Why a script is needed at all. `b90831f` fixed the translator so the `nl`
 * pass covers the prose fields and not just the five spec fields. But both
 * paths that could apply it are hash-guarded: the save subscriber skips when
 * `i18n_source_hash` still matches, and the admin "Vertaal nu" button returns
 * the cached translation for the same reason. Neither the product source nor
 * its hash changes when the translator's own behaviour changes, so every
 * product that already carries a hash is frozen with the old, prose-less `nl`
 * translation. Measured on 2026-08-08: 0 of 31 live products have
 * `i18n.nl.description`, so the Dutch storefront falls back to the English
 * source on every one of them.
 *
 * Safety:
 * - DRY RUN by default. It only calls OpenAI or writes when BACKFILL_NL_APPLY=1.
 * - Skips `i18n_locked` products, exactly as the subscriber does, so hand
 *   edited translations are never overwritten.
 * - Only touches products actually missing Dutch prose. Re-running is a no-op
 *   once they have it, so it is safe to run again.
 * - Writes a fresh `i18n_source_hash`, so the normal save subscriber takes
 *   over correctly afterwards.
 * - One product at a time, sequentially. Three OpenAI calls per product; a
 *   parallel sweep across the catalogue would risk rate limits for no gain at
 *   this size.
 * - A failure on one product is logged and the run continues.
 */
export default async function backfillNlTranslations({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const productModule = container.resolve(Modules.PRODUCT) as IProductModuleService
  const apply = process.env.BACKFILL_NL_APPLY === '1'

  if (!translationConfigured()) {
    logger.error('OPENAI_API_KEY is not set, so translation is inert. Aborting.')
    return
  }

  const products = await productModule.listProducts({}, { take: 1000 })

  const metaStrOf = (metadata: Record<string, unknown>) => (key: string) =>
    typeof metadata[key] === 'string' ? (metadata[key] as string) : null

  type Candidate = { id: string; title: string; source: TranslatableFields }
  const candidates: Candidate[] = []
  let locked = 0
  let alreadyDutch = 0

  for (const product of products) {
    const metadata = (product.metadata ?? {}) as Record<string, unknown>
    if (metadata.i18n_locked === true) {
      locked++
      continue
    }

    // The gap we are closing: an `nl` translation that carries no prose.
    // `description` is the field the catalogue card and the meta description
    // both read, so it is the honest test for "is the Dutch page English".
    const i18n = metadata.i18n as Record<string, Record<string, unknown>> | undefined
    const nlDescription = i18n?.nl?.description
    if (typeof nlDescription === 'string' && nlDescription.trim().length > 0) {
      alreadyDutch++
      continue
    }

    const metaStr = metaStrOf(metadata)
    candidates.push({
      id: product.id,
      title: product.title,
      source: {
        description: product.description ?? null,
        subtitle: product.subtitle ?? null,
        long_description: metaStr('long_description'),
        category: metaStr('category'),
        physical_state: metaStr('physical_state'),
        solubility: metaStr('solubility'),
        shelf_life: metaStr('shelf_life'),
        storage_temp: metaStr('storage_temp'),
        handling_notes: metaStr('handling_notes'),
      },
    })
  }

  logger.info(
    `${products.length} product(s): ${candidates.length} need Dutch prose, ` +
      `${alreadyDutch} already have it, ${locked} locked by an editor.`
  )

  if (!candidates.length) {
    logger.info('Nothing to do.')
    return
  }

  for (const c of candidates) {
    logger.info(`  ${c.title} (${c.id})`)
  }

  if (!apply) {
    logger.info('')
    logger.info(
      `DRY RUN. Nothing was translated and nothing was written. ` +
        `Applying would make ${candidates.length * 3} OpenAI calls on ${OPENAI_MODEL}.`
    )
    logger.info('Re-run with BACKFILL_NL_APPLY=1 to translate.')
    return
  }

  let done = 0
  for (const c of candidates) {
    try {
      const i18n = await translateAll(c.source)
      const current = await productModule.retrieveProduct(c.id)
      const metadata = (current.metadata ?? {}) as Record<string, unknown>

      await productModule.updateProducts(c.id, {
        metadata: {
          ...metadata,
          i18n,
          i18n_source_hash: hashSource(c.source),
          i18n_updated_at: new Date().toISOString(),
          i18n_model: OPENAI_MODEL,
        },
      })

      const nlOk = typeof i18n.nl?.description === 'string' && i18n.nl.description.trim().length > 0
      logger.info(`  translated ${c.title}${nlOk ? '' : '  (WARNING: nl description still empty)'}`)
      done++
    } catch (e) {
      logger.error(`  failed ${c.title} (${c.id}): ${(e as Error).message}`)
    }
  }

  logger.info(`Done. Translated ${done}/${candidates.length} product(s).`)
}
