/**
 * Value serialization utilities for stable hashing and round-tripping.
 *
 * Adapted from TanStack DB's query-db-collection:
 * https://github.com/TanStack/db/blob/main/packages/query-db-collection/src/serialization.ts
 */

interface TypeMarker {
  __type: string
  value?: unknown
  sign?: number
}

function isTypeMarker(value: unknown): value is TypeMarker {
  return (
    typeof value === `object` &&
    value !== null &&
    `__type` in value &&
    typeof (value as TypeMarker).__type === `string`
  )
}

/**
 * Serializes a value into a JSON-safe format that preserves special JS types.
 * Handles: undefined, NaN, Infinity, -Infinity, Date, arrays, and objects.
 */
export function serializeValue(value: unknown): unknown {
  if (value === undefined) {
    return { __type: `undefined` }
  }

  if (typeof value === `number`) {
    if (Number.isNaN(value)) {
      return { __type: `nan` }
    }
    if (value === Number.POSITIVE_INFINITY) {
      return { __type: `infinity`, sign: 1 }
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return { __type: `infinity`, sign: -1 }
    }
  }

  if (
    value === null ||
    typeof value === `string` ||
    typeof value === `number` ||
    typeof value === `boolean`
  ) {
    return value
  }

  if (value instanceof Date) {
    return { __type: `date`, value: value.toJSON() }
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item))
  }

  if (typeof value === `object`) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        serializeValue(val),
      ]),
    )
  }

  return value
}

/**
 * Deserializes a value back from its JSON-safe format.
 * Restores: undefined, NaN, Infinity, -Infinity, Date, arrays, and objects.
 */
export function deserializeValue(value: unknown): unknown {
  if (isTypeMarker(value)) {
    switch (value.__type) {
      case `undefined`:
        return undefined
      case `nan`:
        return NaN
      case `infinity`:
        return value.sign === 1
          ? Number.POSITIVE_INFINITY
          : Number.NEGATIVE_INFINITY
      case `date`:
        return new Date(value.value as string)
      default:
        return value
    }
  }

  if (
    value === null ||
    typeof value === `string` ||
    typeof value === `number` ||
    typeof value === `boolean`
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserializeValue(item))
  }

  if (typeof value === `object`) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        deserializeValue(val),
      ]),
    )
  }

  return value
}

/**
 * Converts a value to a stable string key for use in Sets/Maps.
 */
export function toKey(value: unknown): string {
  return JSON.stringify(serializeValue(value))
}

/**
 * Restores a value from its string key representation.
 */
export function fromKey(key: string): unknown {
  return deserializeValue(JSON.parse(key))
}
