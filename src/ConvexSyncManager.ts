import type { FunctionReference } from 'convex/server'
import type { ChangeMessageOrDeleteKeyMessage } from '@tanstack/db'
import type {
  ConvexClientLike,
  ConvexSyncManagerOptions,
  ExtractedFilters,
  FilterDimension,
} from './types.js'
import { toKey, fromKey } from './serialization.js'

export type { ConvexSyncManagerOptions }

/**
 * Sync callbacks passed from TanStack DB's sync function
 */
export interface SyncCallbacks<
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
}

/**
 * ConvexSyncManager - Manages real-time synchronization with Convex backend
 *
 * Implements the "backfill + tail" pattern:
 * 1. When new filters are requested, backfill with `after: 0` to get full history
 * 2. Maintain a single live subscription for all active filter values with `after: globalCursor - tailOverlapMs`
 * 3. Use LWW (Last-Write-Wins) to handle overlapping data from backfill and subscription
 *
 * Supports 0, 1, or N filter dimensions:
 * - 0 filters: Global sync with just { after }
 * - 1+ filters: Filter-based sync with values extracted from where clauses
 */
export class ConvexSyncManager<
  T extends object = Record<string, unknown>,
  TKey extends string | number = string | number,
> {
  // Configuration
  private client: ConvexClientLike
  private query: FunctionReference<`query`>
  private filterDimensions: FilterDimension[]
  private updatedAtFieldName: string
  private debounceMs: number
  private tailOverlapMs: number
  private resubscribeThreshold: number
  private getKey: (item: T) => TKey

  // State - per-dimension tracking (keyed by convexArg)
  private activeDimensions = new Map<string, Set<string>>()
  private refCounts = new Map<string, number>() // composite key -> count
  private pendingFilters: ExtractedFilters = {}
  private globalCursor = 0
  private currentSubscription: (() => void) | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private isProcessing = false
  private markedReady = false

  // For 0-filter case (global sync)
  private hasRequestedGlobal = false
  private globalRefCount = 0

  // Track messages received since last subscription to batch cursor updates
  private messagesSinceSubscription = 0

  // Sync callbacks (set when sync() is called)
  private callbacks: SyncCallbacks<T, TKey> | null = null

  constructor(options: ConvexSyncManagerOptions<T>) {
    this.client = options.client
    this.query = options.query
    this.filterDimensions = options.filterDimensions
    this.updatedAtFieldName = options.updatedAtFieldName
    this.debounceMs = options.debounceMs
    this.tailOverlapMs = options.tailOverlapMs
    this.resubscribeThreshold = options.resubscribeThreshold
    this.getKey = options.getKey as (item: T) => TKey

    // Initialize activeDimensions for each filter dimension
    for (const dim of this.filterDimensions) {
      this.activeDimensions.set(dim.convexArg, new Set())
    }
  }

  /**
   * Initialize the sync manager with callbacks from TanStack DB
   */
  setCallbacks(callbacks: SyncCallbacks<T, TKey>): void {
    this.callbacks = callbacks
  }

  /**
   * Create a composite key for ref counting multi-filter combinations.
   * Uses serialized values for deterministic keys.
   */
  private createCompositeKey(filters: ExtractedFilters): string {
    // Sort by convexArg for deterministic ordering
    const sorted = Object.keys(filters)
      .sort()
      .reduce(
        (acc, key) => {
          // Serialize values and sort for deterministic ordering
          const values = filters[key]
          if (values) {
            acc[key] = values.map((v) => toKey(v)).sort()
          }
          return acc
        },
        {} as Record<string, string[]>
      )
    return JSON.stringify(sorted)
  }

  /**
   * Request filters to be synced (called by loadSubset)
   * Filters are batched via debouncing for efficiency
   */
  requestFilters(filters: ExtractedFilters): Promise<void> {
    // Handle 0-filter case (global sync)
    if (this.filterDimensions.length === 0) {
      this.globalRefCount++
      if (!this.hasRequestedGlobal) {
        this.hasRequestedGlobal = true
        return this.scheduleProcessing()
      }
      return Promise.resolve()
    }

    // Increment ref count for this filter combination
    const compositeKey = this.createCompositeKey(filters)
    const count = this.refCounts.get(compositeKey) || 0
    this.refCounts.set(compositeKey, count + 1)

    // Track which values are new (not yet active)
    let hasNewValues = false
    for (const [convexArg, values] of Object.entries(filters)) {
      const activeSet = this.activeDimensions.get(convexArg)
      if (!activeSet) continue

      // Find the dimension config for single validation
      const dim = this.filterDimensions.find((d) => d.convexArg === convexArg)

      // Validate single constraint before adding values
      if (dim?.single) {
        const existingCount = activeSet.size
        const pendingCount = this.pendingFilters[convexArg]?.length ?? 0
        const newValues = values.filter((v) => {
          const serialized = toKey(v)
          const alreadyActive = activeSet.has(serialized)
          const alreadyPending = this.pendingFilters[convexArg]?.some(
            (pv) => toKey(pv) === serialized
          )
          return !alreadyActive && !alreadyPending
        })

        if (existingCount + pendingCount + newValues.length > 1) {
          throw new Error(
            `Filter '${dim.filterField}' is configured as single but multiple values were requested. ` +
              `Active: ${existingCount}, Pending: ${pendingCount}, New: ${newValues.length}. ` +
              `Use single: false if you need to sync multiple values.`
          )
        }
      }

      for (const value of values) {
        const serialized = toKey(value)
        if (!activeSet.has(serialized)) {
          // Add to pending filters
          if (!this.pendingFilters[convexArg]) {
            this.pendingFilters[convexArg] = []
          }
          // Check if already pending (by serialized key)
          const alreadyPending = this.pendingFilters[convexArg].some(
            (v) => toKey(v) === serialized
          )
          if (!alreadyPending) {
            this.pendingFilters[convexArg].push(value)
            hasNewValues = true
          }
        }
      }
    }

    // If there are new values, schedule processing
    if (hasNewValues) {
      return this.scheduleProcessing()
    }

    return Promise.resolve()
  }

  /**
   * Release filters when no longer needed (called by unloadSubset)
   */
  releaseFilters(filters: ExtractedFilters): void {
    // Handle 0-filter case
    if (this.filterDimensions.length === 0) {
      this.globalRefCount = Math.max(0, this.globalRefCount - 1)
      if (this.globalRefCount === 0 && this.hasRequestedGlobal) {
        this.hasRequestedGlobal = false
        this.updateSubscription()
      }
      return
    }

    // Decrement ref count for this filter combination
    const compositeKey = this.createCompositeKey(filters)
    const count = (this.refCounts.get(compositeKey) || 0) - 1

    if (count <= 0) {
      this.refCounts.delete(compositeKey)
    } else {
      this.refCounts.set(compositeKey, count)
    }

    // Check if any values are now unreferenced
    this.cleanupUnreferencedValues()
  }

  /**
   * Remove values from activeDimensions that are no longer referenced
   * by any composite key in refCounts
   */
  private cleanupUnreferencedValues(): void {
    // Collect all referenced serialized values per dimension
    const referencedValues = new Map<string, Set<string>>()
    for (const dim of this.filterDimensions) {
      referencedValues.set(dim.convexArg, new Set())
    }

    // Walk through all composite keys and collect their serialized values
    for (const compositeKey of this.refCounts.keys()) {
      try {
        // Composite keys store values as already-serialized strings
        const filters = JSON.parse(compositeKey) as Record<string, string[]>
        for (const [convexArg, serializedValues] of Object.entries(filters)) {
          const refSet = referencedValues.get(convexArg)
          if (refSet) {
            for (const serialized of serializedValues) {
              refSet.add(serialized)
            }
          }
        }
      } catch {
        // Skip invalid keys
      }
    }

    // Remove unreferenced values from activeDimensions
    // (activeDimensions stores serialized keys)
    let needsSubscriptionUpdate = false
    for (const [convexArg, activeSet] of this.activeDimensions) {
      const refSet = referencedValues.get(convexArg)!
      for (const serialized of activeSet) {
        if (!refSet.has(serialized)) {
          activeSet.delete(serialized)
          needsSubscriptionUpdate = true
        }
      }
    }

    if (needsSubscriptionUpdate) {
      this.updateSubscription()
    }
  }

  /**
   * Schedule debounced processing of pending filters
   */
  private scheduleProcessing(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clear existing timer
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
      }

      // Schedule processing
      this.debounceTimer = setTimeout(async () => {
        try {
          await this.processFilterBatch()
          resolve()
        } catch (error) {
          reject(error)
        }
      }, this.debounceMs)
    })
  }

  /**
   * Process the current batch of pending filters
   */
  private async processFilterBatch(): Promise<void> {
    if (this.isProcessing) {
      return
    }

    // Check if there's anything to process
    const hasPendingFilters = Object.keys(this.pendingFilters).length > 0
    const needsGlobalSync = this.filterDimensions.length === 0 && this.hasRequestedGlobal

    if (!hasPendingFilters && !needsGlobalSync) {
      return
    }

    this.isProcessing = true

    try {
      if (this.filterDimensions.length === 0) {
        // 0-filter case: global sync
        await this.runGlobalBackfill()
      } else {
        // Collect new filter values that need backfill
        const newFilters = { ...this.pendingFilters }
        this.pendingFilters = {}

        // Add to active dimensions (store serialized keys)
        for (const [convexArg, values] of Object.entries(newFilters)) {
          const activeSet = this.activeDimensions.get(convexArg)
          if (activeSet) {
            for (const value of values) {
              activeSet.add(toKey(value))
            }
          }
        }

        // Run backfill for new filter values (fetch full history)
        await this.runBackfill(newFilters)
      }

      // Update the live subscription to include all active values
      this.updateSubscription()

      // Mark ready after first successful sync
      if (!this.markedReady && this.callbacks) {
        this.callbacks.markReady()
        this.markedReady = true
      }
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * Run global backfill for 0-filter case
   */
  private async runGlobalBackfill(): Promise<void> {
    try {
      const args: Record<string, unknown> = { after: 0 }

      const items = await this.client.query(this.query, args as any)

      if (Array.isArray(items)) {
        this.handleIncomingData(items as T[])
      }
    } catch (error) {
      console.error('[ConvexSyncManager] Global backfill error:', error)
      throw error
    }
  }

  /**
   * Run backfill query for new filter values to get their full history
   */
  private async runBackfill(newFilters: ExtractedFilters): Promise<void> {
    if (Object.keys(newFilters).length === 0) return

    try {
      // Query with after: 0 to get full history for new filter values
      const args: Record<string, unknown> = {
        ...newFilters,
        after: 0,
      }

      const items = await this.client.query(this.query, args as any)

      if (Array.isArray(items)) {
        this.handleIncomingData(items as T[])
      }
    } catch (error) {
      console.error('[ConvexSyncManager] Backfill error:', error)
      throw error
    }
  }

  /**
   * Build query args from all active dimensions
   */
  private buildQueryArgs(after: number): Record<string, unknown> {
    const args: Record<string, unknown> = { after }

    // Deserialize values back to original types for the Convex query
    for (const [convexArg, serializedValues] of this.activeDimensions) {
      const values = [...serializedValues].map((s) => fromKey(s))

      // Check if this dimension is configured as single
      const dim = this.filterDimensions.find((d) => d.convexArg === convexArg)
      args[convexArg] = dim?.single ? values[0] : values
    }

    return args
  }

  /**
   * Update the live subscription to cover all active filter values
   */
  private updateSubscription(): void {
    // Unsubscribe from current subscription
    if (this.currentSubscription) {
      this.currentSubscription()
      this.currentSubscription = null
    }

    // Reset message counter for new subscription
    this.messagesSinceSubscription = 0

    // Check if we should subscribe
    if (this.filterDimensions.length === 0) {
      // 0-filter case: subscribe if global sync is active
      if (!this.hasRequestedGlobal) {
        return
      }
    } else {
      // Check if any dimension has active values
      let hasActiveValues = false
      for (const activeSet of this.activeDimensions.values()) {
        if (activeSet.size > 0) {
          hasActiveValues = true
          break
        }
      }
      if (!hasActiveValues) {
        return
      }
    }

    // Calculate cursor with overlap to avoid missing updates
    const cursor = Math.max(0, this.globalCursor - this.tailOverlapMs)

    // Build subscription args
    const args = this.buildQueryArgs(cursor)

    // Runtime detection: ConvexClient has onUpdate, ConvexReactClient has watchQuery
    if ('onUpdate' in this.client) {
      // ConvexClient pattern: client.onUpdate(query, args, callback)
      const subscription = this.client.onUpdate(
        this.query,
        args as any,
        (result: unknown) => {
          if (result !== undefined) {
            const items = result as T[]
            if (Array.isArray(items)) {
              this.handleIncomingData(items)
            }
          }
        },
        (error: unknown) => {
          console.error(`[ConvexSyncManager] Subscription error:`, error)
        }
      )
      this.currentSubscription = () => subscription.unsubscribe()
    } else {
      // ConvexReactClient pattern: client.watchQuery(query, args).onUpdate(callback)
      const watch = this.client.watchQuery(this.query, args as any)
      this.currentSubscription = watch.onUpdate(() => {
        // Get current value from the watch
        const result = watch.localQueryResult()
        if (result !== undefined) {
          const items = result as T[]
          if (Array.isArray(items)) {
            this.handleIncomingData(items)
          }
        }
      })
    }
  }

  /**
   * Handle incoming data from backfill or subscription
   * Uses LWW (Last-Write-Wins) to resolve conflicts
   */
  private handleIncomingData(items: T[]): void {
    if (!this.callbacks || items.length === 0) return

    const { collection, begin, write, commit } = this.callbacks

    // Track if we see new items that advance the cursor
    const previousCursor = this.globalCursor
    let newItemCount = 0

    begin()

    for (const item of items) {
      const key = this.getKey(item)
      const incomingTs = (item as any)[this.updatedAtFieldName] as number | undefined

      // Update global cursor to track the latest timestamp we've seen
      if (incomingTs !== undefined && incomingTs > this.globalCursor) {
        this.globalCursor = incomingTs
      }

      const existing = collection.get(key)

      if (!existing) {
        // New item - insert
        write({ type: `insert`, value: item })
        // Count as new if it's beyond the previous cursor (not from overlap)
        if (incomingTs !== undefined && incomingTs > previousCursor) {
          newItemCount++
        }
      } else {
        // Existing item - check if incoming is fresher (LWW)
        const existingTs = (existing as any)[this.updatedAtFieldName] as number | undefined

        if (incomingTs !== undefined && existingTs !== undefined) {
          if (incomingTs > existingTs) {
            // Incoming is fresher - update
            write({ type: `update`, value: item })
            // Count as new if it's beyond the previous cursor
            if (incomingTs > previousCursor) {
              newItemCount++
            }
          }
          // Otherwise skip (stale data from overlap)
        } else if (incomingTs !== undefined) {
          // Existing has no timestamp, incoming does - update
          write({ type: `update`, value: item })
        }
        // If incoming has no timestamp, skip (can't determine freshness)
      }
    }

    commit()

    // Track only new messages (beyond previous cursor) for cursor advancement
    this.messagesSinceSubscription += newItemCount

    // Re-subscribe with advanced cursor after threshold is reached
    if (
      this.resubscribeThreshold > 0 &&
      this.messagesSinceSubscription >= this.resubscribeThreshold &&
      this.currentSubscription !== null
    ) {
      this.updateSubscription()
    }
  }

  /**
   * Clean up all resources
   */
  cleanup(): void {
    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    // Unsubscribe from current subscription
    if (this.currentSubscription) {
      this.currentSubscription()
      this.currentSubscription = null
    }

    // Clear state
    for (const activeSet of this.activeDimensions.values()) {
      activeSet.clear()
    }
    this.refCounts.clear()
    this.pendingFilters = {}
    this.globalCursor = 0
    this.markedReady = false
    this.hasRequestedGlobal = false
    this.globalRefCount = 0
    this.messagesSinceSubscription = 0
    this.callbacks = null
  }

  /**
   * Get debug info about current state
   */
  getDebugInfo(): {
    activeDimensions: Record<string, unknown[]>
    globalCursor: number
    pendingFilters: ExtractedFilters
    hasSubscription: boolean
    markedReady: boolean
    hasRequestedGlobal: boolean
    messagesSinceSubscription: number
  } {
    const activeDimensions: Record<string, unknown[]> = {}
    for (const [convexArg, serializedValues] of this.activeDimensions) {
      activeDimensions[convexArg] = [...serializedValues].map((s) => fromKey(s))
    }

    return {
      activeDimensions,
      globalCursor: this.globalCursor,
      pendingFilters: { ...this.pendingFilters },
      hasSubscription: this.currentSubscription !== null,
      markedReady: this.markedReady,
      hasRequestedGlobal: this.hasRequestedGlobal,
      messagesSinceSubscription: this.messagesSinceSubscription,
    }
  }
}
