import type {
  CollectionConfig,
  LoadSubsetOptions,
  SyncConfig,
  UtilsRecord,
} from '@tanstack/db'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { FunctionReference, FunctionReturnType } from 'convex/server'
import { ConvexSyncManager } from './ConvexSyncManager.js'
import { extractMultipleFilterValues } from './expression-parser.js'
import type { ConvexCollectionConfig, FilterConfig, FilterDimension } from './types.js'

// Re-export types
export type {
  ConvexCollectionConfig,
  ConvexUnsubscribe,
  ExtractedFilters,
  FilterConfig,
  FilterDimension,
} from './types.js'
export { extractFilterValues, extractMultipleFilterValues, hasFilterField } from './expression-parser.js'
export { ConvexSyncManager } from './ConvexSyncManager.js'
export { serializeValue, deserializeValue, toKey, fromKey } from './serialization.js'

// Default configuration values
const DEFAULT_UPDATED_AT_FIELD = `updatedAt`
const DEFAULT_DEBOUNCE_MS = 50
const DEFAULT_TAIL_OVERLAP_MS = 10000
const DEFAULT_RESUBSCRIBE_THRESHOLD = 10

/**
 * Normalize filter configuration to an array of FilterDimension.
 * - undefined = [] (0 filters, global sync)
 * - single object = [object] (1 filter)
 * - array = array as-is (N filters)
 */
function normalizeFilterConfig(filters: FilterConfig): FilterDimension[] {
  if (filters === undefined) return []
  return Array.isArray(filters) ? filters : [filters]
}

/**
 * Schema output type inference helper
 */
type InferSchemaOutput<T> = T extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<T> extends object
    ? StandardSchemaV1.InferOutput<T>
    : Record<string, unknown>
  : Record<string, unknown>

/**
 * Infer the item type from a Convex query's return type.
 * Expects the query to return an array of items.
 */
type InferQueryItemType<TQuery extends FunctionReference<'query'>> =
  FunctionReturnType<TQuery> extends Array<infer T>
    ? T extends object
      ? T
      : Record<string, unknown>
    : Record<string, unknown>

/**
 * Creates collection options for use with TanStack DB's createCollection.
 * This integrates Convex real-time subscriptions with TanStack DB collections
 * using the "backfill + tail" synchronization pattern.
 *
 * @example
 * ```typescript
 * import { createCollection } from '@tanstack/react-db'
 * import { convexCollectionOptions } from '@michaelstewart/convex-tanstack-db-collection'
 * import { api } from '@convex/_generated/api'
 *
 * // Single filter dimension
 * const messagesCollection = createCollection(
 *   convexCollectionOptions({
 *     client: convexClient,
 *     query: api.messages.sync,
 *     filters: { filterField: 'pageId', convexArg: 'pageIds' },
 *     getKey: (msg) => msg._id,
 *
 *     onInsert: async ({ transaction }) => {
 *       const newMsg = transaction.mutations[0].modified
 *       await convexClient.mutation(api.messages.create, newMsg)
 *     },
 *   })
 * )
 *
 * // Multiple filter dimensions
 * const filteredCollection = createCollection(
 *   convexCollectionOptions({
 *     client: convexClient,
 *     query: api.items.syncFiltered,
 *     filters: [
 *       { filterField: 'pageId', convexArg: 'pageIds' },
 *       { filterField: 'authorId', convexArg: 'authorIds' },
 *     ],
 *     getKey: (item) => item._id,
 *   })
 * )
 *
 * // No filters (global sync)
 * const allItemsCollection = createCollection(
 *   convexCollectionOptions({
 *     client: convexClient,
 *     query: api.items.syncAll,  // Query takes only { after }
 *     getKey: (item) => item._id,
 *   })
 * )
 *
 * // In UI:
 * const { data: messages } = useLiveQuery(q =>
 *   q.from({ msg: messagesCollection })
 *    .where(({ msg }) => msg.pageId.eq('page-123'))
 * )
 * ```
 */

// Overload for when schema is provided
export function convexCollectionOptions<
  TSchema extends StandardSchemaV1,
  TKey extends string | number = string | number,
  TUtils extends UtilsRecord = UtilsRecord,
>(
  config: ConvexCollectionConfig<InferSchemaOutput<TSchema>, TKey, TSchema, TUtils> & {
    schema: TSchema
  }
): CollectionConfig<InferSchemaOutput<TSchema>, TKey, TSchema, TUtils>

// Overload for when no schema is provided - T is inferred from query's return type
export function convexCollectionOptions<
  TQuery extends FunctionReference<'query'>,
  T extends InferQueryItemType<TQuery> = InferQueryItemType<TQuery>,
  TKey extends string | number = string | number,
  TUtils extends UtilsRecord = UtilsRecord,
>(
  config: Omit<ConvexCollectionConfig<T, TKey, never, TUtils>, 'query'> & {
    schema?: never
    query: TQuery
    getKey: (item: T) => TKey
  }
): CollectionConfig<T, TKey, never, TUtils>

// Implementation - uses concrete types; overloads provide proper type inference
export function convexCollectionOptions(
  config: ConvexCollectionConfig<Record<string, unknown>, string | number, never, UtilsRecord>
): CollectionConfig<Record<string, unknown>, string | number, never, UtilsRecord> {
  const {
    client,
    query,
    filters,
    updatedAtFieldName = DEFAULT_UPDATED_AT_FIELD,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    tailOverlapMs = DEFAULT_TAIL_OVERLAP_MS,
    resubscribeThreshold = DEFAULT_RESUBSCRIBE_THRESHOLD,
    getKey,
    onInsert,
    onUpdate,
    ...baseConfig
  } = config

  // Normalize filter configuration
  const filterDimensions = normalizeFilterConfig(filters)

  // Create the sync manager
  const syncManager = new ConvexSyncManager<any, any>({
    client,
    query,
    filterDimensions,
    updatedAtFieldName,
    debounceMs,
    tailOverlapMs,
    resubscribeThreshold,
    getKey: getKey as (item: any) => string | number,
  })

  // Create the sync configuration
  const syncConfig: SyncConfig<any, any> = {
    sync: (params) => {
      const { collection, begin, write, commit, markReady } = params

      // Initialize sync manager with callbacks
      syncManager.setCallbacks({
        collection: {
          get: (key) => collection.get(key),
          has: (key) => collection.has(key),
        },
        begin,
        write,
        commit,
        markReady,
      })

      // Return loadSubset, unloadSubset, and cleanup handlers
      return {
        loadSubset: (options: LoadSubsetOptions): Promise<void> => {
          // 0-filter case: global sync
          if (filterDimensions.length === 0) {
            return syncManager.requestFilters({})
          }

          // Extract filter values from the where expression
          const extracted = extractMultipleFilterValues(options, filterDimensions)

          // Sync if ANY dimension has values (any-filter matching)
          // Convex query arg validators enforce which combinations are valid
          if (Object.keys(extracted).length === 0) {
            // No filter values found - this is expected for queries that filter
            // by other fields (e.g., clientId, parentId). These queries read from
            // the already-synced collection and don't need to trigger a sync.
            return Promise.resolve()
          }

          return syncManager.requestFilters(extracted)
        },

        unloadSubset: (options: LoadSubsetOptions): void => {
          // 0-filter case: global sync
          if (filterDimensions.length === 0) {
            syncManager.releaseFilters({})
            return
          }

          // Extract filter values from the where expression
          const extracted = extractMultipleFilterValues(options, filterDimensions)

          if (Object.keys(extracted).length > 0) {
            syncManager.releaseFilters(extracted)
          }
        },

        cleanup: () => {
          syncManager.cleanup()
        },
      }
    },
  }

  // Return the complete collection config
  return {
    ...baseConfig,
    getKey,
    syncMode: `on-demand`, // Always on-demand since we sync based on query predicates
    sync: syncConfig,
    onInsert,
    onUpdate,
  }
}
