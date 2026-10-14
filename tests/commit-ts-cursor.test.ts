// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { ConvexSyncManager } from '../src/ConvexSyncManager.js'
import type { FunctionReference } from 'convex/server'
import type { ConvexClientLike } from '../src/types.js'

type Row = { _id: string; pageId: string; updatedAt: bigint }

/**
 * A ConvexClient stand-in that records every subscription's args and lets
 * the test push results into the live one.
 */
function makeFakeClient(backfills: Array<Array<Row>>) {
  const subscriptions: Array<{
    args: Record<string, unknown>
    push: (rows: Array<Row>) => void
  }> = []
  const backfillArgs: Array<Record<string, unknown>> = []
  const client = {
    query: (_query: unknown, args: Record<string, unknown>) => {
      backfillArgs.push(args)
      return Promise.resolve(backfills.shift() ?? [])
    },
    onUpdate: (
      _query: unknown,
      args: Record<string, unknown>,
      callback: (result: unknown) => void,
    ) => {
      subscriptions.push({ args, push: (rows) => callback(rows) })
      return { unsubscribe: () => {} }
    },
  } as unknown as ConvexClientLike
  return { client, subscriptions, backfillArgs }
}

const fakeQuery = {} as FunctionReference<'query'>

function makeManager(client: ConvexClientLike) {
  const store = new Map<string, Row>()
  const manager = new ConvexSyncManager<Row, string>({
    client,
    query: fakeQuery,
    filterDimensions: [{ filterField: `pageId`, convexArg: `pageIds` }],
    updatedAtFieldName: `updatedAt`,
    updatedAtType: `int64`,
    debounceMs: 0,
    tailOverlapMs: 10_000,
    resubscribeThreshold: 1,
    getKey: (row) => row._id,
  })
  manager.setCallbacks({
    collection: {
      get: (key) => store.get(key),
      has: (key) => store.has(key),
    },
    begin: () => {},
    write: (message) => {
      if (message.type === `insert` || message.type === `update`) {
        store.set(message.value._id, message.value)
      }
    },
    commit: () => {},
    markReady: () => {},
  })
  return { manager, store }
}

describe(`ConvexSyncManager — int64 commit timestamp cursor`, () => {
  it(`subscribes at the exact largest commit timestamp, with no overlap`, async () => {
    const { client, subscriptions } = makeFakeClient([
      [
        { _id: `a`, pageId: `p1`, updatedAt: 1_000n },
        { _id: `b`, pageId: `p1`, updatedAt: 3_000n },
      ],
    ])
    const { manager } = makeManager(client)
    await manager.requestFilters({ pageIds: [`p1`] })

    expect(subscriptions).toHaveLength(1)
    expect(subscriptions[0]!.args.after).toBe(3_000n)
  })

  it(`sends 0n for the backfill and the first subscription, so an int64 arg validator accepts both`, async () => {
    const { client, subscriptions, backfillArgs } = makeFakeClient([[]])
    const { manager } = makeManager(client)
    await manager.requestFilters({ pageIds: [`p1`] })
    expect(backfillArgs[0]!.after).toBe(0n)
    expect(subscriptions[0]!.args.after).toBe(0n)
  })

  it(`lets only the live subscription move the cursor once one exists`, async () => {
    const { client, subscriptions } = makeFakeClient([
      [{ _id: `a`, pageId: `p1`, updatedAt: 1_000n }],
      // The backfill for p2 runs against a later snapshot than the live
      // subscription has delivered
      [{ _id: `z`, pageId: `p2`, updatedAt: 9_000n }],
    ])
    const { manager, store } = makeManager(client)
    await manager.requestFilters({ pageIds: [`p1`] })
    expect(subscriptions[0]!.args.after).toBe(1_000n)

    await manager.requestFilters({ pageIds: [`p2`] })
    // The resubscription for {p1, p2} must not skip past p1 commits the old
    // subscription had not delivered yet
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1]!.args.after).toBe(1_000n)
    expect(store.get(`z`)?.updatedAt).toBe(9_000n)

    // A commit on p1 that landed in the gap still arrives, and it is the
    // subscription's delivery, not the backfill's later rows, that the cursor
    // now follows
    subscriptions[1]!.push([{ _id: `b`, pageId: `p1`, updatedAt: 5_000n }])
    expect(store.get(`b`)?.updatedAt).toBe(5_000n)
    expect(manager.getDebugInfo().globalCursor).toBe(5_000n)
  })

  it(`keeps the overlap rewind for wall-clock number cursors`, async () => {
    const { client, subscriptions } = makeFakeClient([
      [{ _id: `a`, pageId: `p1`, updatedAt: 50_000 as unknown as bigint }],
    ])
    const store = new Map<string, Row>()
    const manager = new ConvexSyncManager<Row, string>({
      client,
      query: fakeQuery,
      filterDimensions: [{ filterField: `pageId`, convexArg: `pageIds` }],
      updatedAtFieldName: `updatedAt`,
      debounceMs: 0,
      tailOverlapMs: 10_000,
      resubscribeThreshold: 1,
      getKey: (row) => row._id,
    })
    manager.setCallbacks({
      collection: { get: (k) => store.get(k), has: (k) => store.has(k) },
      begin: () => {},
      write: () => {},
      commit: () => {},
      markReady: () => {},
    })
    await manager.requestFilters({ pageIds: [`p1`] })
    expect(subscriptions[0]!.args.after).toBe(40_000)
  })
})
