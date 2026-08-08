/**
 * DHL Parcel capabilities matching. Pure: no HTTP, no Medusa imports.
 *
 * WHY THIS EXISTS (order #28416, 2026-08-08): DHL does not ignore an option it
 * cannot honour, it rejects the whole label with
 * `400 {"key":"capabilities_retrieve_empty"}`. The option set is per LANE, not
 * global. Verified live against the prod gateway:
 *
 *   NL -> NL  (DFY-B2C)            DOOR, PS, REFERENCE, HANDT, SSN, ...
 *   NL -> BE  (DFY-B2C)            DOOR, PS, REFERENCE, HANDT, SSN, ...
 *   NL -> DE/DK/ES/FR/GB/IT/SE     DOOR, PS, REFERENCE, ...  NO HANDT, NO SSN
 *     (DHL PARCEL CONNECT / EUROPLUS)
 *
 * So HANDT (signature on delivery) and SSN (undisclosed sender) must be dropped
 * for most cross-border orders, but kept for NL and BE. Rather than hard-code
 * that table, ask DHL and intersect | it stays correct when DHL changes it.
 */

export type DhlCapabilityOption = {
  key?: string
  optionType?: string
  exclusions?: Array<{ key?: string }> | null
}

export type DhlCapability = {
  product?: { key?: string; label?: string } | null
  parcelType?: { key?: string } | null
  options?: DhlCapabilityOption[] | null
}

export type DhlOptionSelection = {
  /** Required keys plus the wanted keys DHL offers, in the order requested. */
  keys: string[]
  /** Wanted keys this lane does not offer (or that clash with a chosen one). */
  dropped: string[]
  /** DHL product the selection was matched against, for logging. */
  productKey?: string
  /** Human label of that product, for logging. */
  productLabel?: string
}

function optionKeys(entry: DhlCapability): Map<string, DhlCapabilityOption> {
  const map = new Map<string, DhlCapabilityOption>()
  for (const option of entry.options ?? []) {
    if (option?.key) map.set(option.key.toUpperCase(), option)
  }
  return map
}

/** True when `candidate` and any already-chosen key exclude each other. */
function clashes(
  candidate: string,
  chosen: string[],
  offered: Map<string, DhlCapabilityOption>,
): boolean {
  const excludes = (a: string, b: string): boolean =>
    (offered.get(a)?.exclusions ?? []).some((e) => e?.key?.toUpperCase() === b)

  return chosen.some((key) => excludes(candidate, key) || excludes(key, candidate))
}

/**
 * Pick the DHL options to send for one lane + parcel type.
 *
 * @param capabilities raw GET /capabilities/business body (unknown on purpose:
 *   it comes straight off the wire)
 * @param parcelTypeKey the parcel type the box preset selected (e.g. "SMALL")
 * @param required keys the shipment cannot go without (the delivery option)
 * @param wanted keys to keep only where the lane offers them, best-first
 * @returns null when the lane cannot carry this parcel type / required option
 *   at all | the caller must then fail with an operator-readable message
 *   instead of letting DHL answer 400.
 */
export function selectDhlOptions(
  capabilities: unknown,
  parcelTypeKey: string,
  required: string[],
  wanted: string[],
): DhlOptionSelection | null {
  if (!Array.isArray(capabilities)) return null

  const parcelType = parcelTypeKey.toUpperCase()
  const req = required.map((k) => k.toUpperCase())
  const want = wanted.map((k) => k.toUpperCase())

  let best: DhlOptionSelection | null = null

  for (const entry of capabilities as DhlCapability[]) {
    if (entry?.parcelType?.key?.toUpperCase() !== parcelType) continue

    const offered = optionKeys(entry)
    if (!req.every((key) => offered.has(key))) continue

    const keys = [...req]
    for (const key of want) {
      if (!offered.has(key)) continue
      if (clashes(key, keys, offered)) continue
      keys.push(key)
    }

    // Highest number of wanted options kept wins; ties keep the first entry,
    // which preserves DHL's own product ranking.
    if (best && keys.length <= best.keys.length) continue
    best = {
      keys,
      dropped: want.filter((key) => !keys.includes(key)),
      productKey: entry.product?.key,
      productLabel: entry.product?.label,
    }
  }

  return best
}
