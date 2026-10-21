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
    args: { pageIds?: Array<string> }
    resolve: (rows: Array<Row>) => void
    reject: (error: unknown) => void
  }> = []
  const subscriptions: Array<{ pageIds?: Array<string> }> = []
  const client = {
    query: (_fn: unknown, args: { pageIds?: Array<string> }) =>
      new Promise<Array<Row>>((resolve, reject) => {
        backfills.push({ args, resolve, reject })
      }),
    onUpdate: (_fn: unknown, args: { pageIds?: Array<string> }) => {
      subscriptions.push(args)
      return { unsubscribe: () => {} }
    },
  } as unknown as ConvexClientLike
  return { client, backfills, subscriptions }
}

function makeCollection(client: ConvexClientLike, id: string) {
  return createCollection(
    convexCollectionOptions<FunctionReference<'query'>, Row, string>({
      id,
      client,
      query: fakeQuery,
      filters: { filterField: `pageId`, convexArg: `pageIds` },
      updatedAtFieldName: `updatedAt`,
      getKey: (r) => r._id,
    }),
  )
}

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
