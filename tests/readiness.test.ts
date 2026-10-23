// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'

import { convexCollectionOptions } from '../src/index.js'
import type { FunctionReference } from 'convex/server'
import type { ConvexClientLike } from '../src/types.js'

type Row = {
  _id: string
  pageId: string
  updatedAt: number
  [key: string]: unknown
}

const fakeQuery = {} as FunctionReference<'query'>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const row = (id: string, pageId: string): Row => ({
  _id: id,
  pageId,
  updatedAt: 1,
})

/**
 * A ConvexClient stand-in whose backfills are held until the test releases
 * them, so the order in which loads land is the test's to choose.
 */
function makeHeldClient() {
  const backfills: Array<{
    args: { pageIds?: Array<string>; after?: unknown }
    resolve: (rows: Array<Row>) => void
    reject: (error: unknown) => void
  }> = []
  const subscriptions: Array<{ pageIds?: Array<string> }> = []
  // The subscriptions still open: what the tail covers right now.
  const active: Array<{ pageIds?: Array<string> }> = []
  const client = {
    query: (_fn: unknown, args: { pageIds?: Array<string>; after?: unknown }) =>
      new Promise<Array<Row>>((resolve, reject) => {
        backfills.push({ args, resolve, reject })
      }),
    onUpdate: (_fn: unknown, args: { pageIds?: Array<string> }) => {
      subscriptions.push(args)
      active.push(args)
      return {
        unsubscribe: () => {
          const index = active.indexOf(args)
          if (index !== -1) active.splice(index, 1)
        },
      }
    },
  } as unknown as ConvexClientLike
  return { client, backfills, subscriptions, active }
}

/** The one subscription the tail is holding, or null if there is none. */
function covered(active: Array<{ pageIds?: Array<string> }>) {
  if (active.length !== 1) return null
  return [...(active[0]!.pageIds ?? [])].sort()
}

function makeCollection(
  client: ConvexClientLike,
  id: string,
  updatedAtType: 'number' | 'int64' = 'number',
) {
  return createCollection(
    convexCollectionOptions<FunctionReference<'query'>, Row, string>({
      id,
      client,
      query: fakeQuery,
      filters: { filterField: `pageId`, convexArg: `pageIds` },
      updatedAtFieldName: `updatedAt`,
      updatedAtType,
      getKey: (r) => r._id,
    }),
  )
}

// Wall-clock cursors are rewound by the default 10s overlap, so a row
// stamped here is caught up from `after: 10_000` — a value the assertions
// below can tell from the zero a fresh backfill sends.
const LANDED_AT = 20_000
const CAUGHT_UP_FROM = 10_000

/** A live query for one page, subscribed the way a mounted hook is. */
function liveFor(
  collection: ReturnType<typeof makeCollection>,
  pageId: string,
) {
  const live = createLiveQueryCollection({
    startSync: true,
    query: (q) =>
      q.from({ t: collection }).where(({ t }) => eq(t.pageId, pageId)),
  })
  // A live query loads nothing until something subscribes.
  const subscription = live.subscribeChanges(() => {})
  return { live, subscription }
}

// The debounce window is 50ms by default; this is comfortably past it.
const PAST_DEBOUNCE = 80

describe(`readiness of a filtered live query`, () => {
  it(`a second query for a value whose backfill is in flight waits for it`, async () => {
    const { client, backfills } = makeHeldClient()
    const collection = makeCollection(client, `in-flight`)

    // Page Y loads and lands, so the collection itself is ready.
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1)
    backfills[0]!.resolve([row(`y1`, `Y`)])
    await liveY.preload()
    expect(collection.status).toBe(`ready`)

    // Page X is requested; its backfill is held in flight.
    const { live: first } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    expect(first.status).not.toBe(`ready`)

    // A second query for X arrives while that backfill is still in flight.
    // It used to be handed a resolved promise, and read as ready with no rows.
    const { live: second } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(second.status).not.toBe(`ready`)
    expect(backfills).toHaveLength(2) // and did not fetch X twice

    backfills[1]!.resolve([row(`x1`, `X`), row(`x2`, `X`)])
    await second.preload()
    expect(first.toArray).toHaveLength(2)
    expect(second.toArray).toHaveLength(2)
  })

  it(`a batch whose window closes during another backfill is queued, not dropped`, async () => {
    const { client, backfills, subscriptions } = makeHeldClient()
    const collection = makeCollection(client, `queued`)

    const { live: liveX } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1) // X in flight

    // Y's window closes while X is still in flight. It used to be dropped:
    // Y's query read as ready with no rows and Y never reached the tail.
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(liveY.status).not.toBe(`ready`)

    backfills[0]!.resolve([row(`x1`, `X`)])
    await liveX.preload()
    await sleep(0)
    expect(backfills).toHaveLength(2)
    expect(backfills[1]!.args.pageIds).toEqual([`Y`])
    expect(liveY.status).not.toBe(`ready`)

    backfills[1]!.resolve([row(`y1`, `Y`)])
    await liveY.preload()
    expect(liveY.toArray).toHaveLength(1)
    expect(subscriptions.at(-1)?.pageIds).toEqual([`X`, `Y`])
  })

  it(`every request inside one debounce window settles with the window`, async () => {
    const { client, backfills } = makeHeldClient()
    const collection = makeCollection(client, `window`)

    const { live: liveX } = liveFor(collection, `X`)
    await sleep(10)
    // Re-arms the timer. X's promise used to be stranded by that, leaving
    // X's query loading forever even once its rows were in.
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1)
    expect(backfills[0]!.args.pageIds).toEqual([`X`, `Y`])

    backfills[0]!.resolve([row(`x1`, `X`), row(`y1`, `Y`)])
    await Promise.all([liveX.preload(), liveY.preload()])
    expect(liveX.status).toBe(`ready`)
    expect(liveY.status).toBe(`ready`)
    expect(liveX.toArray).toHaveLength(1)
    expect(liveY.toArray).toHaveLength(1)
  })

  it(`a value released and requested again while in flight is backfilled again`, async () => {
    const { client, backfills, subscriptions } = makeHeldClient()
    const collection = makeCollection(client, `remount`)

    const { live: first, subscription } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1)

    // The only requester of X goes away while X is in flight...
    subscription.unsubscribe()
    await first.cleanup()
    await sleep(10)

    // ...and a fresh one appears. It must not be told X is loaded.
    const { live: second } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(second.status).not.toBe(`ready`)

    backfills[0]!.resolve([row(`x1`, `X`)])
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    backfills[1]!.resolve([row(`x1`, `X`)])
    await second.preload()
    expect(second.toArray).toHaveLength(1)
    expect(subscriptions.at(-1)?.pageIds).toEqual([`X`])
  })

  it(`a value released after it landed is ready again at once, and caught up from its cursor`, async () => {
    const { client, backfills, subscriptions } = makeHeldClient()
    const collection = makeCollection(client, `revisit`)

    const { live: first, subscription } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1)
    backfills[0]!.resolve([{ ...row(`x1`, `X`), updatedAt: LANDED_AT }])
    await first.preload()
    expect(first.toArray).toHaveLength(1)

    // The only requester of X goes away after X has landed, as a route
    // unmounting does.
    subscription.unsubscribe()
    await first.cleanup()
    await sleep(10)

    // Coming back, the rows are still there, so the query is ready without
    // waiting on anything — nothing has been released to it.
    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(1)

    // The catch-up behind it asks for what happened since, not for history.
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    expect(backfills[1]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
    backfills[1]!.resolve([
      { ...row(`x1`, `X`), updatedAt: LANDED_AT + 1 },
      { ...row(`x2`, `X`), updatedAt: LANDED_AT + 2 },
    ])
    await sleep(10)
    expect(second.toArray).toHaveLength(2)
    expect(subscriptions.at(-1)?.pageIds).toEqual([`X`])
  })

  it(`a failed catch-up keeps what was shown, and is tried again on the next request`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(client, `revisit-offline`)

    const { live: first, subscription } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    backfills[0]!.resolve([{ ...row(`x1`, `X`), updatedAt: LANDED_AT }])
    await first.preload()
    subscription.unsubscribe()
    await first.cleanup()
    await sleep(10)

    const { live: second, subscription: secondSubscription } = liveFor(
      collection,
      `X`,
    )
    await second.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    backfills[1]!.reject(new Error(`offline`))
    await sleep(PAST_DEBOUNCE)

    // Nobody was waiting on the catch-up's promise, so nothing fails on
    // screen — and its requester is still here, so the tail covers X from
    // now on rather than leaving a mounted query with no subscription.
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(1)
    expect(covered(active)).toEqual([`X`])

    // The gap behind it is still owed: the next request for X catches it
    // up again, from the same cursor.
    secondSubscription.unsubscribe()
    await second.cleanup()
    await sleep(10)
    const { live: third } = liveFor(collection, `X`)
    await third.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    expect(backfills[2]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
  })

  it(`a fresh value that fails in the same window does not cost a caught-up value its subscription`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(client, `revisit-beside-failure`)

    const { live: first, subscription } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    backfills[0]!.resolve([{ ...row(`x1`, `X`), updatedAt: LANDED_AT }])
    await first.preload()
    subscription.unsubscribe()
    await first.cleanup()
    await sleep(10)

    // X comes back and Y is asked for the first time, in one window: the
    // catch-up for X is issued beside the backfill for Y.
    const { live: second } = liveFor(collection, `X`)
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    expect(backfills[1]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
    expect(backfills[2]!.args).toEqual({ pageIds: [`Y`], after: 0 })

    backfills[1]!.resolve([{ ...row(`x2`, `X`), updatedAt: LANDED_AT + 1 }])
    backfills[2]!.reject(new Error(`Y failed`))
    await sleep(PAST_DEBOUNCE)

    // Y fails as before; X is ready with its rows and the tail covers it.
    expect(liveY.status).toBe(`error`)
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(2)
    expect(covered(active)).toEqual([`X`])
  })

  it(`a value released while its catch-up is in flight keeps the cursor it had`, async () => {
    const { client, backfills } = makeHeldClient()
    const collection = makeCollection(client, `revisit-release-mid-flight`)

    const { live: first, subscription } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    backfills[0]!.resolve([{ ...row(`x1`, `X`), updatedAt: LANDED_AT }])
    await first.preload()
    subscription.unsubscribe()
    await first.cleanup()
    await sleep(10)

    // X is asked for again beside a fresh Y. Y lands first, far ahead of X,
    // and with no subscription open its rows move the global cursor.
    const { live: second, subscription: secondSubscription } = liveFor(
      collection,
      `X`,
    )
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    backfills[2]!.resolve([{ ...row(`y1`, `Y`), updatedAt: LANDED_AT * 5 }])
    await liveY.preload()

    // X's requester leaves while X's catch-up is still in flight. The
    // global cursor now says nothing about X, and must not be stamped on it.
    secondSubscription.unsubscribe()
    await second.cleanup()
    await sleep(10)
    backfills[1]!.resolve([])
    await sleep(PAST_DEBOUNCE)

    // The next request catches X up from where it was, not from Y's rows.
    const { live: third } = liveFor(collection, `X`)
    await third.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(4)
    expect(backfills[3]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
  })

  it(`a commit-timestamp cursor is passed to the catch-up unchanged`, async () => {
    const { client, backfills } = makeHeldClient()
    const collection = makeCollection(client, `revisit-int64`, `int64`)
    const landedAt = 20_000n as unknown as number

    const { live: first, subscription } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    backfills[0]!.resolve([{ ...row(`x1`, `X`), updatedAt: landedAt }])
    await first.preload()
    subscription.unsubscribe()
    await first.cleanup()
    await sleep(10)

    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    // No overlap rewind: a commit timestamp is an exact lower bound.
    expect(backfills[1]!.args).toEqual({ pageIds: [`X`], after: 20_000n })
  })

  it(`a failed backfill rejects everyone waiting and lets the value be retried`, async () => {
    const { client, backfills } = makeHeldClient()
    const collection = makeCollection(client, `retry`)

    const { live: first } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    const { live: second } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1)

    backfills[0]!.reject(new Error(`backfill failed`))
    await sleep(PAST_DEBOUNCE)
    expect(first.status).toBe(`error`)
    expect(second.status).toBe(`error`)

    // A new query for X fetches it again rather than reusing the failure.
    const { live: third } = liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    backfills[1]!.resolve([row(`x1`, `X`)])
    await third.preload()
    expect(third.toArray).toHaveLength(1)
  })
})
