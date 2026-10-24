# Convex TanStack DB Collection

On-demand real-time sync between [Convex](https://convex.dev) and [TanStack DB](https://tanstack.com/db) collections.

Uses a **backfill + tail** pattern: fetch the current state for the filters your UI is asking
for, then keep one live subscription running with a cursor to catch everything after it. The
cursor is a Convex **commit timestamp**, so it is exact: no polling, no changelog table, and no
re-sending data you already have.

```typescript
const messagesCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.messages.getMessagesAfter,
    filters: { filterField: 'channelId', convexArg: 'channelIds' },
    updatedAtType: 'int64', // `updatedAt` is v.commitTs()
    getKey: (msg) => msg.id,
  }),
)
```

Requires Convex 1.43+ for `v.commitTs()`. If you are on an older version, or your `updatedAt` is
a wall-clock millisecond number you maintain yourself, see
[Wall-clock `updatedAt`](#wall-clock-updatedat-the-original-mode) at the bottom.

## Installation

```bash
npm install @michaelstewart/convex-tanstack-db-collection
# or
pnpm add @michaelstewart/convex-tanstack-db-collection
```

## Example Use Case

Imagine a Slack-like app with messages inside channels.

### 1. Stamp rows with the commit timestamp

Declare `updatedAt` as `v.commitTs()` and index it alongside whatever you filter on:

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  channels: defineTable({
    name: v.string(),
  }),
  messages: defineTable({
    // Client-generated UUID to support optimistic inserts
    id: v.string(),
    channelId: v.id('channels'),
    authorId: v.string(),
    body: v.string(),
    // Assigned by the database at commit time; an int64 of nanoseconds
    updatedAt: v.commitTs(),
  })
    .index('by_channel_updatedAt', ['channelId', 'updatedAt'])
    .index('by_author_updatedAt', ['authorId', 'updatedAt']),
})
```

Every mutation that touches a row writes the placeholder, and never reads it back in the same
transaction:

```typescript
// convex/messages.ts
await ctx.db.insert('messages', { ...data, updatedAt: ctx.db.vars.commitTs })
await ctx.db.patch(id, { body, updatedAt: ctx.db.vars.commitTs })
```

### 2. Write the sync query

It takes your filter arrays plus an `after` cursor, as a bigint:

```typescript
// convex/messages.ts
import { v } from 'convex/values'
import { query } from './_generated/server'

export const getMessagesAfter = query({
  args: {
    channelIds: v.optional(v.array(v.id('channels'))),
    after: v.optional(v.int64()),
  },
  handler: async (ctx, { channelIds, after = 0n }) => {
    if (!channelIds || channelIds.length === 0) return []

    const results = await Promise.all(
      channelIds.map((channelId) =>
        ctx.db
          .query('messages')
          .withIndex('by_channel_updatedAt', (q) =>
            q.eq('channelId', channelId).gt('updatedAt', after),
          )
          .collect(),
      ),
    )
    return results.flat()
  },
})
```

The compound index `['channelId', 'updatedAt']` is what makes this cheap: "all messages in this
channel committed after this point" is a single range scan.

### 3. Create the collection

```typescript
// src/collections.ts
import { createCollection } from '@tanstack/react-db'
import { convexCollectionOptions } from '@michaelstewart/convex-tanstack-db-collection'
import { api } from '@convex/_generated/api'

const messagesCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.messages.getMessagesAfter,
    filters: { filterField: 'channelId', convexArg: 'channelIds' },
    updatedAtType: 'int64',
    getKey: (msg) => msg.id,
  }),
)

// In your UI - TanStack DB extracts channelId from the where clause
const { data: messages } = useLiveQuery((q) =>
  q
    .from({ msg: messagesCollection })
    .where(({ msg }) => msg.channelId.eq(currentChannelId)),
)
```

Rows arrive with `updatedAt` as a `bigint` of nanoseconds. Divide by `1_000_000n` if you need
milliseconds for display.

See `examples/convex-tutorial` for a working chat app demonstrating optimistic inserts and
cursor-based sync.

## How It Works

1. **Filter extraction**: parses TanStack DB `where` clauses to extract the filter values on screen
2. **Backfill**: fetches current state for filter values it has not seen before, with `after: 0n`.
   A value it _has_ seen is ready at once and caught up from where the subscription left it
   (see [Leaving and coming back](#leaving-and-coming-back))
3. **Subscription merging**: maintains a _single_ live Convex subscription covering every active
   filter value
4. **Cursor advancement**: periodically re-subscribes with the cursor moved forward, so the
   subscription stops re-sending rows the client already holds
5. **LWW conflict resolution**: where backfill and subscription overlap, the higher `updatedAt`
   wins

**Why one subscription for all filters?** Convex function calls are billed on subscription
creation and on each subscription update. Fifty active filter values as fifty subscriptions gets
expensive, so they are merged into one that tracks changes across all of them.

**Only the live subscription moves the cursor.** A backfill for a newly requested filter runs
against a later snapshot than the subscription has delivered. If its rows advanced the cursor and
the subscription were then replaced with `after: thatCursor`, a commit on an already-subscribed
filter that the old subscription had not yet pushed would be skipped forever. (Before the first
subscription exists there is nothing in flight to miss, so the initial backfill may set the
starting cursor.)

## Design Background

### Why Not a Changelog?

[ElectricSQL](https://tanstack.com/db/latest/docs/collections/electric-collection) syncs from
Postgres using the write-ahead log as a changelog. Every transaction has a globally-ordered
transaction ID, so Electric can stream exactly what changed and clients can confirm their
mutations have synced by waiting for a specific txid.

Convex has no global transaction log you can read. There is no single writer handing out
sequential IDs. What it does have is:

1. **Reactive subscriptions**: queries re-run automatically when their dependencies change,
   tracked efficiently via index ranges in the query's read set
2. **Commit timestamps**: a field the database stamps at commit time, in commit order, strictly
   increasing across the deployment, and indexable

Together those are enough to build an update log out of an ordinary index, and to sync it with a
cursor.

### Why the Commit Timestamp Makes the Cursor Exact

`ctx.db.vars.commitTs` is a placeholder inside the mutation; when the transaction commits the
backend replaces it with an int64 of nanoseconds. Because the value is assigned at the moment the
row becomes visible, _the largest value a subscription has delivered is an exact lower bound_:
nothing with a smaller value can turn up later. So `after: cursor` can be the highest timestamp
seen, with no safety margin, no duplicate traffic, and no ordering obligations on your mutation
code.

This is the part a wall-clock `updatedAt` can never give you. A mutation generates `Date.now()`
when it _starts_ but the row appears when it _commits_, and those two orders disagree:

```
T=1000: Transaction A generates updatedAt=1000 for key1
T=1001: Transaction B generates updatedAt=1001 for key2
T=1002: Transaction B commits first  → key2 visible with updatedAt=1001
T=1003: Transaction A commits second → key1 visible with updatedAt=1000
```

See key2, advance the cursor to 1001, re-subscribe, and key1 is never delivered. The original
mode worked around this by rewinding the cursor a fixed window on every resubscription and
re-sending whatever landed in it. Commit timestamps remove the race rather than padding around
it.

### Leaving and coming back

A live query that unmounts releases its filter values, and the subscription stops covering
them. The rows it loaded are not dropped — nothing in this adapter truncates the collection —
so a query that asks for the same value later finds them still there. Making it wait for a
fresh `after: 0n` backfill anyway would turn every second visit into a round trip with nothing
on screen, which is the failure a growing cache exists to avoid.

So a value that has landed once is **stale-while-revalidate** from then on. When its last
requester lets go, the adapter remembers the cursor the subscription had reached. The next
request for it is ready immediately, with the rows it had, and the batch it joins runs a
catch-up query for everything committed since that cursor (one query covers every stale value
in the batch, from the earliest of their cursors). Rows that changed while nobody was looking
arrive and win by LWW; rows that did not are re-sent and ignored. The subscription is then
extended to cover the value again, as for any new one.

Three things keep this honest.

A value released while its first backfill is still in flight has never landed, so it is
backfilled from zero again rather than shown empty.

A catch-up that fails is not a failure of the query that triggered it: nobody is waiting on its
promise. But its requester is still subscribed, so the value stays in the subscription and is
covered from that point on. It keeps its cursor, and the next request for it runs the catch-up
again, which fills the gap. Until something asks, a reader who stayed on the page through the
failure sees new commits but not the ones made while they were away. A fresh value that fails
to load in the same window does not take the subscription down with it either.

"Landed" and "covered" are different moments. A catch-up landing means the rows are in as of a
snapshot; the value is covered only once the subscription has been rebuilt to include it. A
value loses its cursor only at the second moment, and only if it is still active then. One
released before that keeps the older cursor, because the shared cursor was advanced by rows on
other values and says nothing about how far this one is covered.

The catch-up for a batch reads from the earliest of its values' cursors, so one long-abandoned
value makes the others in that batch re-fetch more than they need; LWW discards it, and the
cost is bytes, not correctness. The load records and cursors grow with every value ever seen,
as the collection's rows already do — nothing in this adapter truncates, and these are
proportional to that.

Soft deletes fit this naturally: a row deleted while the value was released comes back through
the catch-up with its `deletedAt` set, as it would through the subscription. A hard delete does
not, which is the same limitation as below.

### Migrating an Existing `updatedAt`

Convex index ordering is type-first: _every_ int64 sorts before _every_ float, whatever the
magnitude. So while a table still holds a mix of wall-clock numbers and commit timestamps, a
bigint `gt('updatedAt', after)` range will not see the un-migrated float rows at all. Convert the
column before, or at the same time as, switching `updatedAtType`. Don't run the two modes against
one table and expect the ranges to interleave.

<details>
<summary><strong>More Examples</strong></summary>

### Multiple Filter Dimensions

You can filter by multiple fields using the same sync query:

```typescript
// Filter by channel OR by author - both use the same getMessagesAfter query
const messagesCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.messages.getMessagesAfter,
    filters: [
      { filterField: 'channelId', convexArg: 'channelIds' },
      { filterField: 'authorId', convexArg: 'authorIds' },
    ],
    updatedAtType: 'int64',
    getKey: (msg) => msg.id,
  }),
)

// View messages in a channel
const { data: channelMessages } = useLiveQuery((q) =>
  q
    .from({ msg: messagesCollection })
    .where(({ msg }) => msg.channelId.eq(channelId)),
)

// Or view all messages by an author
const { data: authorMessages } = useLiveQuery((q) =>
  q
    .from({ msg: messagesCollection })
    .where(({ msg }) => msg.authorId.eq(userId)),
)
```

The matching Convex query picks an index per dimension:

```typescript
// convex/messages.ts
export const getMessagesAfter = query({
  args: {
    channelIds: v.optional(v.array(v.id('channels'))),
    authorIds: v.optional(v.array(v.string())),
    after: v.optional(v.int64()),
  },
  handler: async (ctx, { channelIds, authorIds, after = 0n }) => {
    if (channelIds && channelIds.length > 0) {
      const results = await Promise.all(
        channelIds.map((channelId) =>
          ctx.db
            .query('messages')
            .withIndex('by_channel_updatedAt', (q) =>
              q.eq('channelId', channelId).gt('updatedAt', after),
            )
            .collect(),
        ),
      )
      return results.flat()
    }

    if (authorIds && authorIds.length > 0) {
      const results = await Promise.all(
        authorIds.map((authorId) =>
          ctx.db
            .query('messages')
            .withIndex('by_author_updatedAt', (q) =>
              q.eq('authorId', authorId).gt('updatedAt', after),
            )
            .collect(),
        ),
      )
      return results.flat()
    }

    return []
  },
})
```

### Global Sync (No Filters)

For small datasets, sync everything:

```typescript
const allMessagesCollection = createCollection(
  convexCollectionOptions({
    client: convexClient,
    query: api.messages.getAllMessagesAfter, // Query takes only { after }
    updatedAtType: 'int64',
    getKey: (msg) => msg.id,
  }),
)
```

</details>

<details>
<summary><strong>Configuration Reference</strong></summary>

## Configuration

### Filter Options

```typescript
interface FilterDimension {
  // Field name in TanStack DB queries (e.g., 'channelId')
  filterField: string

  // Convex query argument name (e.g., 'channelIds')
  convexArg: string

  // If true, assert only one value is ever requested (default: false)
  // Throws error if multiple values requested, and passes the value directly
  // rather than as an array
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

  // Timestamp field used as the cursor and for LWW (default: 'updatedAt')
  updatedAtFieldName?: string

  // 'int64' for a v.commitTs() field: the cursor is exact, no overlap, and
  // `after` is sent as a bigint. 'number' (default) for a wall-clock ms
  // field, which rewinds the cursor by tailOverlapMs on every resubscription.
  updatedAtType?: 'number' | 'int64'

  // Debounce for batching loadSubset calls (default: 50ms)
  debounceMs?: number

  // Overlap window when rewinding subscription cursor (default: 10000ms)
  // Ignored when updatedAtType is 'int64'
  tailOverlapMs?: number

  // Messages before re-subscribing with advanced cursor (default: 10)
  // Set to 0 to disable cursor advancement entirely
  resubscribeThreshold?: number

  // Mutation handlers
  onInsert?: (params) => Promise<void>
  onUpdate?: (params) => Promise<void>
}
```

</details>

## Limitations

### Hard Deletes Not Supported

When a record is deleted from Convex, other subscribed clients have no way to learn about it.
The sync query only returns items that exist.

**Use soft deletes instead:**

```typescript
// Instead of deleting:
await ctx.db.delete(id)

// Set a status field:
await ctx.db.patch(id, {
  status: 'deleted',
  updatedAt: ctx.db.vars.commitTs,
})
```

The sync will receive the updated record with `status: 'deleted'`, and your UI can filter it out:

```typescript
const { data } = useLiveQuery((q) =>
  q
    .from({ item: itemsCollection })
    .where(({ item }) => item.status.eq('active')),
)
```

### Filter Expressions

Only `.eq()` and `.in()` operators are supported for filter extraction. Complex expressions like
`.gt()`, `.lt()`, or nested `or` conditions on filter fields won't work.

## When to Use This

**Consider starting with
[query-collection](https://tanstack.com/db/latest/docs/collections/query-collection)** if you have
few items on screen. It's simpler, uses Convex's built-in `useQuery` under the hood, and is
sufficient for many apps.

This adapter is for when you need:

- **On-demand sync**: specifically load data matching your current queries
- **Cursor-based efficiency**: avoid re-fetching unchanged data on every subscription update

<details>
<summary><strong>Wall-clock <code>updatedAt</code> (the original mode)</strong></summary>

## Wall-clock `updatedAt` (the original mode)

Before Convex 1.43 added `v.commitTs()`, the only cursor available was a `Date.now()` your own
mutations wrote. This is still the default (`updatedAtType: 'number'`, or just leaving it unset),
but it costs you two things the commit-timestamp path doesn't: a monotonicity obligation on every
writer, and a window of duplicate traffic on every resubscription. Prefer `'int64'` for new code.

### Lamport Timestamps

Cursor-based sync needs `updatedAt` to be non-decreasing _per key_, even across servers with
skewed clocks. That means every mutation has to read the previous value and bump past it:

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

Every call site has to remember this. One that forgets is a row a cursor can skip.

### The Tail Overlap

Per-key monotonicity does not extend _across_ keys. A transaction generates its timestamp when it
starts but becomes visible when it commits, so a smaller value can appear after a larger one (the
worked example is under
[Why the Commit Timestamp Makes the Cursor Exact](#why-the-commit-timestamp-makes-the-cursor-exact)).

The fix is a deliberately conservative subscription cursor:

```typescript
subscriptionCursor = globalCursor - tailOverlapMs
```

This creates an overlap window where some data is re-received. LWW resolution on `updatedAt`
handles the duplicates: for any key, the higher timestamp wins.

**The tradeoff:** a larger overlap means more duplicate data but safer sync. A smaller overlap
saves bandwidth but risks missing updates from transactions that take longer than the window to
commit.

### Tuning the Tail Overlap

The default `tailOverlapMs` of 10 seconds is generous. Convex has a
[1-second execution time limit](https://docs.convex.dev/production/state/limits) for user code in
mutations, so it's unlikely a record becomes visible multiple seconds after another record with a
later timestamp, though it's technically possible under degraded DB performance or bad clock
skew.

Even set ultra-conservatively to 5 minutes, you'd still cut duplicate traffic by orders of
magnitude in most apps. Ask yourself: what percentage of the data on this page was written in the
last 5 minutes? For many applications, a small fraction.

</details>
