# @michaelstewart/convex-tanstack-db-collection

On-demand real-time sync between [Convex](https://convex.dev) and [TanStack DB](https://tanstack.com/db) collections.

## When to Use This

**Consider starting with [query-collection](https://tanstack.com/db/latest/docs/collections/query-collection)** if you have few items on screen. It's simpler, uses Convex's built-in `useQuery` under the hood, and is sufficient for many apps.

This adapter is for when you need:
- **On-demand sync**: Specifically load data matching your current queries
- **Cursor-based efficiency**: Avoid re-fetching unchanged data on every subscription update

## Core Principles

### How Electric Does It

ElectricSQL syncs from Postgres using the write-ahead log (WAL) as a changelog. Every transaction has a globally-ordered transaction ID (txid), so Electric can stream exactly what changed and clients can confirm when their mutations are synced by waiting for specific txids.

### Convex's Different Model

Convex doesn't have a global transaction log—there's no single writer assigning sequential IDs. Instead, Convex provides:

1. **Optimistic concurrency control (OCC)**: Transactions are serializable per-key, with automatic retry on conflicts
2. **Reactive subscriptions**: Queries automatically re-run when their dependencies change, tracked efficiently via index ranges in query read sets

This adapter uses these superpowers to construct an **update log** from an index on `updatedAt`. Because OCC guarantees that `updatedAt` is non-decreasing for any given key (it acts as a Lamport timestamp), we can query `after: cursor` to fetch only newer records.

The result is efficient cursor-based sync—with two caveats:
1. Cross-key ordering requires a [tail overlap](#the-tail-overlap-why-we-need-it)
2. [Hard deletes are unsupported](#hard-deletes-not-supported)

### The Backfill + Tail Pattern

We use a two-phase sync:

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: BACKFILL                                               │
│ Query with after: 0 → Get full current state for filter values  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: TAIL                                                   │
│ Subscribe with after: globalCursor - tailOverlapMs              │
│ Single subscription covers ALL active filter values             │
└─────────────────────────────────────────────────────────────────┘
```

**Why one subscription for all filters?**

Convex function calls are billed on subscription creation and subscription update. If you have 50 filter values active, 50 separate subscriptions could be expensive. Instead, we merge them into one subscription that tracks changes across all values, using cursor advancement to minimize redundant data.

### The Tail Overlap (Why We Need It)

The per-key timestamp guarantee doesn't extend across keys. Specifically, **commit order doesn't match timestamp generation order**:

```
T=1000: Transaction A generates updatedAt=1000 for key1
T=1001: Transaction B generates updatedAt=1001 for key2
T=1002: Transaction B commits first  → key2 visible with updatedAt=1001
T=1003: Transaction A commits second → key1 visible with updatedAt=1000
```

If we see key2 first, advance `globalCursor` to 1001, and re-subscribe with `after: 1001`, we'd **never see key1** because `1000 < 1001`.

The **tail overlap** (`tailOverlapMs`, default 10 seconds) solves this with a conservative the subscription cursor:

```typescript
subscriptionCursor = globalCursor - tailOverlapMs
```

This creates an overlap window where we re-receive some data. The LWW (Last-Write-Wins) resolution using `updatedAt` handles duplicates correctly—for any given key, we keep whichever version has the higher timestamp.

**The tradeoff:** A larger overlap means more duplicate data but safer sync. A smaller overlap saves bandwidth but risks missing updates if transactions take longer than the window to commit.

## Installation

```bash
npm install @michaelstewart/convex-tanstack-db-collection
# or
pnpm add @michaelstewart/convex-tanstack-db-collection
```

## Usage

```typescript
import { createCollection } from '@tanstack/react-db'
import { convexCollectionOptions } from '@michaelstewart/convex-tanstack-db-collection'
import { api } from '@convex/_generated/api'

// Single filter dimension
const messagesCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.messages.sync,
    filters: { filterField: 'pageId', convexArg: 'pageIds' },
    getKey: (msg) => msg._id,

    onInsert: async ({ transaction }) => {
      const newMsg = transaction.mutations[0].modified
      await convexClient.mutation(api.messages.create, newMsg)
    },
  })
)

// Multiple filter dimensions
const filteredCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.items.syncFiltered,
    filters: [
      { filterField: 'pageId', convexArg: 'pageIds' },
      { filterField: 'authorId', convexArg: 'authorIds' },
    ],
    getKey: (item) => item._id,
  })
)

// No filters (global sync)
const allItemsCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.items.syncAll,
    getKey: (item) => item._id,
  })
)

// In your UI:
const { data: messages } = useLiveQuery(q =>
  q.from({ msg: messagesCollection })
   .where(({ msg }) => msg.pageId.eq('page-123'))
)
```

## Convex Query Setup

Your Convex sync query should accept filter arrays and an `after` timestamp:

```typescript
// convex/messages.ts
import { v } from 'convex/values'
import { query } from './_generated/server'

export const sync = query({
  args: {
    pageIds: v.array(v.string()),
    after: v.optional(v.number()),
  },
  handler: async (ctx, { pageIds, after = 0 }) => {
    return await ctx.db
      .query('messages')
      .filter(q =>
        q.and(
          q.or(...pageIds.map(id => q.eq(q.field('pageId'), id))),
          q.gt(q.field('updatedAt'), after)
        )
      )
      .collect()
  },
})
```

### Lamport Timestamps

Your documents must have an `updatedAt` field that you update on every mutation. To guarantee monotonicity within each key, even with updates from different servers with skewed clocks, use a Lamport style timestamp:

```typescript
/**
 * Calculate a monotonically increasing updatedAt timestamp.
 * Uses max(Date.now(), prevUpdatedAt + 1) to handle server clock skew.
 */
function getLamportUpdatedAt(prevUpdatedAt: number): number {
  return Math.max(Date.now(), prevUpdatedAt + 1)
}

// On insert
await ctx.db.insert('messages', {
  ...data,
  updatedAt: Date.now(), // No previous timestamp, so Date.now() is fine
})

// On update
const existing = await ctx.db.get(id)
await ctx.db.patch(id, {
  ...changes,
  updatedAt: getLamportUpdatedAt(existing.updatedAt),
})
```


## Configuration

### Filter Options

```typescript
interface FilterDimension {
  // Field name in TanStack DB queries (e.g., 'pageId')
  filterField: string

  // Convex query argument name (e.g., 'pageIds')
  convexArg: string

  // If true, assert only one value is ever requested (default: false)
  // Throws error if multiple values requested
  single?: boolean
}
```

### Full Config

```typescript
interface ConvexCollectionConfig {
  client: ConvexClient | ConvexReactClient
  query: FunctionReference<'query'>
  getKey: (item: T) => string | number

  // Filter configuration (optional)
  filters?: FilterDimension | FilterDimension[]

  // Timestamp field for LWW conflict resolution (default: 'updatedAt')
  updatedAtFieldName?: string

  // Debounce for batching loadSubset calls (default: 50ms)
  debounceMs?: number

  // Overlap window when rewinding subscription cursor (default: 10000ms)
  // See "The Tail Overlap" section above for why this is needed
  tailOverlapMs?: number

  // Messages before re-subscribing with advanced cursor (default: 10)
  // Set to 0 to disable cursor advancement entirely
  resubscribeThreshold?: number

  // Mutation handlers
  onInsert?: (params) => Promise<void>
  onUpdate?: (params) => Promise<void>
}
```

### Tuning the Tail Overlap

The default `tailOverlapMs` of 10 seconds is generous. Convex has a [1-second execution time limit](https://docs.convex.dev/production/state/limits) for user code in mutations, so it's unlikely that a record becomes visible multiple seconds after another record with a later timestamp. However I expect it is technically possible in cases of degraded DB performance or bad clock skew.

Even if you set this ultra-conservatively to 5 minutes, you'd still cut duplicate traffic by orders of magnitude in most apps. Ask yourself: what percentage of data on this page was written in the last 5 minutes? For many applications, it's a small fraction.

## How It Works

1. **Filter Extraction**: Parses TanStack DB `where` clauses to extract filter values
2. **Backfill**: Fetches full history for new filter values with `after: 0`
3. **Subscription Merging**: Maintains a single Convex subscription for all active filter values
4. **LWW Conflict Resolution**: Uses `updatedAt` timestamps to handle overlapping data
5. **Cursor Advancement**: Periodically re-subscribes with advanced cursor to reduce data transfer

## Limitations

### Hard Deletes Not Supported

This adapter does not support hard deletes. When a record is deleted from Convex, other subscribed clients have no way to learn about the deletion—the sync query only returns items that exist.

**Use soft deletes instead:**

```typescript
// Instead of deleting:
await ctx.db.delete(id)

// Set a status field:
await ctx.db.patch(id, {
  status: 'deleted',
  updatedAt: Date.now()
})
```

The sync will receive the updated record with `status: 'deleted'`. Your UI can filter out deleted items:

```typescript
const { data } = useLiveQuery(q =>
  q.from({ item: itemsCollection })
   .where(({ item }) => item.status.eq('active'))
)
```

### Filter Expressions

Only `.eq()` and `.in()` operators are supported for filter extraction. Complex expressions like `.gt()`, `.lt()`, or nested `or` conditions on filter fields won't work.

## License

MIT
