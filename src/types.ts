import type {
  BaseCollectionConfig,
  ChangeMessageOrDeleteKeyMessage,
  CollectionConfig,
  UtilsRecord,
} from '@tanstack/db'
import type { FunctionReference } from 'convex/server'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Single filter dimension configuration.
 * Maps a TanStack DB query field to a Convex query argument.
 */
export interface FilterDimension {
  /**
   * Field name in TanStack DB queries to extract filter values from.
   * This is the field used in `where` expressions like `m.pageId.eq('p1')`.
   * @example 'pageId'
   */
  filterField: string

  /**
   * Argument name to pass to the Convex query for filter values.
   * This should match the array argument in your Convex query.
   * @example 'pageIds' for a Convex query with `args: { pageIds: v.array(v.string()) }`
   */
  convexArg: string

  /**
   * If true, assert that only one value is ever requested for this filter.
   * An error will be thrown if multiple values are requested.
   * When single is true, the value is passed directly (not as an array).
   * @default false
   * @example
   * // Convex query expects: { pageId: v.string() }
   * filters: { filterField: 'pageId', convexArg: 'pageId', single: true }
   */
  single?: boolean
}

/**
 * Filter configuration supporting 0, 1, or N dimensions.
 * - undefined or [] = sync everything (0 filters)
 * - single object = one filter
 * - array = multiple filters
 */
export type FilterConfig = FilterDimension | FilterDimension[] | undefined

/**
 * Extracted filter values keyed by convexArg for direct use in query args.
 * Values preserve their original types (strings, numbers, etc.)
 * @example { pageIds: ['p1', 'p2'], authorIds: ['u1'] }
 */
export interface ExtractedFilters {
  [convexArg: string]: unknown[]
}

/**
 * Unsubscribe function returned by Convex client.onUpdate
 */
export type ConvexUnsubscribe<T> = {
  (): void
  unsubscribe(): void
  getCurrentValue(): T | undefined
}

/**
 * Watch object returned by watchQuery, provides onUpdate subscription.
 * Note: onUpdate callback is called when value changes but doesn't receive the value.
 * Use localQueryResult() to get the current value.
 */
export interface ConvexWatch<T> {
  onUpdate: (callback: () => void) => () => void
  localQueryResult: () => T | undefined
}

/**
 * Unsubscribe object returned by ConvexClient.onUpdate
 */
export interface ConvexOnUpdateSubscription<T> {
  (): void
  unsubscribe(): void
  getCurrentValue(): T | undefined
}

/**
 * Base client interface with query method
 */
interface ConvexClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(query: FunctionReference<'query'>, args: any): Promise<any>
}

/**
 * ConvexReactClient pattern: uses watchQuery for subscriptions
 */
interface ConvexReactClientLike extends ConvexClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  watchQuery(query: FunctionReference<'query'>, args: any): {
    onUpdate(callback: () => void): () => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    localQueryResult(): any
  }
}

/**
 * ConvexClient pattern: uses onUpdate for subscriptions
 */
interface ConvexBrowserClientLike extends ConvexClientBase {
  onUpdate(
    query: FunctionReference<'query'>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (result: any) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError?: (error: any) => void
  ): {
    unsubscribe(): void
  }
}

/**
 * A Convex client that supports query and subscription methods.
 * Compatible with both ConvexClient (browser) and ConvexReactClient (react).
 *
 * ConvexClient uses: client.onUpdate(query, args, callback)
 * ConvexReactClient uses: client.watchQuery(query, args).onUpdate(callback)
 */
export type ConvexClientLike = ConvexReactClientLike | ConvexBrowserClientLike

/**
 * Configuration for the Convex collection adapter
 */
export interface ConvexCollectionConfig<
  T extends object = Record<string, unknown>,
  TKey extends string | number = string | number,
  TSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
> extends Omit<BaseCollectionConfig<T, TKey, TSchema, TUtils>, 'syncMode'> {
  /**
   * The Convex client instance used for queries and subscriptions.
   * Compatible with both ConvexClient and ConvexReactClient.
   */
  client: ConvexClientLike

  /**
   * The Convex query function reference for syncing data.
   * This query must accept the configured filter args (arrays of filter values)
   * and an optional `after` timestamp for incremental sync.
   *
   * @example
   * // convex/messages.ts
   * export const sync = userQuery({
   *   args: {
   *     pageIds: v.array(v.string()),
   *     after: v.optional(v.number()),
   *   },
   *   handler: async (ctx, { pageIds, after = 0 }) => {
   *     return await ctx.db
   *       .query('messages')
   *       .filter(q => pageIds.includes(q.field('pageId')))
   *       .filter(q => q.gt(q.field('updatedAt'), after))
   *       .collect()
   *   },
   * })
   */
  query: FunctionReference<'query'>

  /**
   * Filter configuration for syncing data based on query predicates.
   * - undefined or [] = sync everything (0 filters, query takes only { after })
   * - single object = one filter dimension
   * - array = multiple filter dimensions
   *
   * @example
   * // Single filter
   * filters: { filterField: 'pageId', convexArg: 'pageIds' }
   *
   * // Multiple filters
   * filters: [
   *   { filterField: 'pageId', convexArg: 'pageIds' },
   *   { filterField: 'authorId', convexArg: 'authorIds' },
   * ]
   */
  filters?: FilterConfig

  /**
   * The field name on items that contains the timestamp for LWW conflict resolution.
   * Used to determine which version of an item is newer.
   * @default 'updatedAt'
   */
  updatedAtFieldName?: string

  /**
   * Debounce time in milliseconds for batching loadSubset calls.
   * Multiple calls within this window will be batched together.
   * @default 50
   */
  debounceMs?: number

  /**
   * Overlap window in milliseconds when rewinding the subscription cursor.
   * This ensures we don't miss updates from transactions that committed out-of-order
   * (commit order doesn't match timestamp generation order across different keys).
   * @default 10000
   */
  tailOverlapMs?: number

  /**
   * Number of messages to receive before re-subscribing with an advanced cursor.
   * This reduces Convex function invocations by batching cursor updates.
   * Set to 0 to disable automatic cursor advancement.
   * @default 10
   */
  resubscribeThreshold?: number
}

/**
 * Internal sync parameters passed to the sync function
 */
export interface ConvexSyncParams<
  T extends object = Record<string, unknown>,
  TKey extends string | number = string | number,
> {
  collection: {
    get: (key: TKey) => T | undefined
    has: (key: TKey) => boolean
  }
  begin: () => void
  write: (message: ChangeMessageOrDeleteKeyMessage<T, TKey>) => void
  commit: () => void
  markReady: () => void
  truncate: () => void
}

/**
 * Options for the ConvexSyncManager
 */
export interface ConvexSyncManagerOptions<T extends object = Record<string, unknown>> {
  client: ConvexClientLike
  query: FunctionReference<'query'>
  filterDimensions: FilterDimension[]
  updatedAtFieldName: string
  debounceMs: number
  tailOverlapMs: number
  resubscribeThreshold: number
  getKey: (item: T) => string | number
}

/**
 * The complete collection config after processing by convexCollectionOptions
 */
export type ConvexCollectionFullConfig<
  T extends object = Record<string, unknown>,
  TKey extends string | number = string | number,
  TSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
> = CollectionConfig<T, TKey, TSchema, TUtils>

