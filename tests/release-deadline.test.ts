// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCollection,
  createLiveQueryCollection,
  eq,
  inArray,
} from '@tanstack/db'

import { convexCollectionOptions } from '../src/index.js'
import type { FunctionReference } from 'convex/server'
import type { ConvexClientLike } from '../src/types.js'

/**
 * The probe from the staging first-load investigation, ported: it needs no
 * Convex, only a client stand-in, and it is the regression guard for the
 * deadline. The behaviour it catches — a released value carried in the
 * subscription's args for the life of the collection — passes any test that
 * only checks which rows arrive, because the rows are all correct.
 */

type Row = {
  _id: string
  pageId: string
  updatedAt: number
}

const fakeQuery = {} as FunctionReference<'query'>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const row = (pageId: string): Row => ({
  _id: `${pageId}-row`,
  pageId,
  updatedAt: 1,
})

// The tail, scaled down from five minutes so a test can outlive it — and
// still wide enough that a request can land inside one.
const TAIL = 250
// The debounce window is 50ms by default; this is comfortably past it.
const PAST_DEBOUNCE = 80
// Long enough that a deadline set at the start of the wait has passed.
const PAST_THE_TAIL = TAIL + 150
// What the probe waited: the point is not that it is a long time but that
// nothing at all happens in it.
const EIGHT_TAILS = TAIL * 8

/** A client whose backfills resolve at once with a row per page asked for. */
function makeClient() {
  type Subscription = {
    pageIds: Array<string>
    unsubscribed: boolean
  }
  const subscriptions: Array<Subscription> = []
  const client = {
    query: async (
      _fn: unknown,
      args: { pageIds?: Array<string> },
    ): Promise<Array<Row>> => (args.pageIds ?? []).map((id) => row(id)),
    onUpdate: (
      _fn: unknown,
      args: { pageIds?: Array<string> },
      _onRows: (rows: Array<Row>) => void,
    ) => {
      const entry: Subscription = {
        pageIds: [...(args.pageIds ?? [])],
        unsubscribed: false,
      }
      subscriptions.push(entry)
      return {
        unsubscribe: () => {
          entry.unsubscribed = true
        },
      }
    },
  } as unknown as ConvexClientLike
  return { client, subscriptions }
}

/**
 * What the live subscription carries right now: the `pageIds` argument of
 * the one open subscription, or null when the tail is empty.
 */
function covered(
  subscriptions: Array<{ pageIds: Array<string>; unsubscribed: boolean }>,
) {
  const open = subscriptions.filter((s) => !s.unsubscribed)
  if (open.length !== 1) return null
  return [...open[0]!.pageIds].sort()
}

function makeCollection(
  client: ConvexClientLike,
  id: string,
  options: { releaseAfterMs?: number; maxHeldValues?: number } = {},
) {
  return createCollection(
    convexCollectionOptions<FunctionReference<'query'>, Row, string>({
      id,
      client,
      query: fakeQuery,
      filters: { filterField: `pageId`, convexArg: `pageIds` },
      updatedAtFieldName: `updatedAt`,
      releaseAfterMs: options.releaseAfterMs ?? TAIL,
      maxHeldValues: options.maxHeldValues,
      getKey: (r) => r._id,
    }),
  )
}

/** A live query for a band of pages, subscribed the way a mounted list is. */
function liveForBand(
  collection: ReturnType<typeof makeCollection>,
  pageIds: Array<string>,
) {
  const live = createLiveQueryCollection({
    startSync: true,
    query: (q) =>
      q
        .from({ t: collection })
        .where(({ t }) =>
          pageIds.length === 1
            ? eq(t.pageId, pageIds[0]!)
            : inArray(t.pageId, pageIds),
        ),
  })
  // A live query loads nothing until something subscribes.
  const subscription = live.subscribeChanges(() => {})
  return { live, subscription }
}

/** The query's requester goes away, as a route unmounting does. */
async function leave(handle: ReturnType<typeof liveForBand>) {
  handle.subscription.unsubscribe()
  await handle.live.cleanup()
  await sleep(10)
}

/** Asks for pages and waits for the batch that puts them in the tail. */
async function ask(
  collection: ReturnType<typeof makeCollection>,
  pageIds: Array<string>,
) {
  const handle = liveForBand(collection, pageIds)
  await handle.live.preload()
  await sleep(PAST_DEBOUNCE)
  return handle
}

const band = (n: number) =>
  Array.from({ length: n }, (_, i) => `page-${String(i).padStart(2, `0`)}`)

describe(`the released-value tail has a deadline`, () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`empties on its own: a band walked through and left behind goes, with nothing else ever asked for`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-band`)
    const forty = band(40)

    // 1. A list asks for a band of 40.
    const list = await ask(collection, forty)
    expect(covered(subscriptions)).toEqual([...forty].sort())

    // 2. The list unmounts: all 40 are released, and stay in the tail.
    await leave(list)
    expect(covered(subscriptions)).toEqual([...forty].sort())

    // 3. A page route asks for its own page, inside the tail: 41 covered.
    const page = await ask(collection, [`page-x`])
    expect(covered(subscriptions)).toEqual([...forty, `page-x`].sort())

    // 4. Eight times the tail passes with the reader sitting on that one
    // page, asking for nothing. This is the step the probe was written for:
    // the band used to still be in the argument of every batched query,
    // because the prune only ran for a batch that had new values to add.
    await sleep(EIGHT_TAILS)
    expect(covered(subscriptions)).toEqual([`page-x`])

    // 5. And the page being read is still covered, with nothing refetched.
    expect(page.live.toArray).toHaveLength(1)
  })

  it(`takes the whole tail out when the last requester leaves, down to no subscription at all`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-empty`)

    await leave(await ask(collection, band(5)))
    expect(covered(subscriptions)).toHaveLength(5)

    await sleep(PAST_THE_TAIL)
    // Nobody wants anything, so there is nothing to subscribe to.
    expect(covered(subscriptions)).toBeNull()
    expect(subscriptions.every((s) => s.unsubscribed)).toBe(true)
  })

  it(`retires values one deadline at a time, so a value released later keeps its whole tail`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-staggered`)

    const first = await ask(collection, [`page-a`])
    const second = await ask(collection, [`page-b`])
    const reader = await ask(collection, [`page-c`])

    await leave(first)
    await sleep(TAIL * 0.6)
    await leave(second)

    // Past page-a's deadline but not page-b's: page-a has gone and page-b
    // has not, rather than both going at the earlier of the two.
    await sleep(TAIL * 0.6)
    expect(covered(subscriptions)).toEqual([`page-b`, `page-c`])

    await sleep(PAST_THE_TAIL)
    expect(covered(subscriptions)).toEqual([`page-c`])
    expect(reader.live.toArray).toHaveLength(1)
  })

  it(`a value asked for again inside its tail keeps its place, and nothing is fetched or resubscribed`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-revisit`)
    const queries: Array<unknown> = []
    const spy = vi.spyOn(client as unknown as { query: () => unknown }, `query`)

    await leave(await ask(collection, [`page-a`]))
    const openBefore = subscriptions.length
    spy.mockClear()
    void queries

    // Back inside the tail, before its deadline.
    const again = liveForBand(collection, [`page-a`])
    await again.live.preload()
    expect(again.live.toArray).toHaveLength(1)
    await sleep(PAST_DEBOUNCE)
    expect(spy).not.toHaveBeenCalled() // nothing to fetch
    expect(subscriptions).toHaveLength(openBefore) // nothing resubscribed

    // And the deadline it had is gone with the release it belonged to: the
    // value is wanted, so it stays however long the reader stays.
    await sleep(PAST_THE_TAIL)
    expect(covered(subscriptions)).toEqual([`page-a`])
  })

  it(`a value released, asked for again, and released again gets a fresh deadline from the second release`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-refreshed`)
    await ask(collection, [`page-keep`]) // stays mounted, so a tail exists

    await leave(await ask(collection, [`page-a`]))
    await sleep(TAIL * 0.6)
    const again = await ask(collection, [`page-a`])
    await leave(again)

    // Past the first release's deadline, inside the second's.
    await sleep(TAIL * 0.6)
    expect(covered(subscriptions)).toEqual([`page-a`, `page-keep`])

    await sleep(PAST_THE_TAIL)
    expect(covered(subscriptions)).toEqual([`page-keep`])
  })

  it(`a value pruned by its deadline is ready again at once, and caught up rather than refetched from zero`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-catch-up`)
    const spy = vi.spyOn(client as unknown as { query: () => unknown }, `query`)

    const first = await ask(collection, [`page-a`])
    expect(first.live.toArray).toHaveLength(1)
    await leave(first)
    await sleep(PAST_THE_TAIL)
    expect(covered(subscriptions)).toBeNull()

    spy.mockClear()
    const second = liveForBand(collection, [`page-a`])
    await second.live.preload()
    // Its rows never left the collection, so the query is ready with them.
    expect(second.live.status).toBe(`ready`)
    expect(second.live.toArray).toHaveLength(1)
    await sleep(PAST_DEBOUNCE)
    // The catch-up behind it asks for what happened since the tail last
    // covered it, not for its history.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(covered(subscriptions)).toEqual([`page-a`])
  })

  it(`a collection cleaned up with values still held leaves no timer behind`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `deadline-cleanup`)

    await leave(await ask(collection, [`page-a`]))
    expect(covered(subscriptions)).toEqual([`page-a`])

    await collection.cleanup()
    // The deadline was cleared with everything else, so nothing fires into
    // a torn-down collection.
    await sleep(PAST_THE_TAIL)
    expect(subscriptions.every((s) => s.unsubscribed)).toBe(true)
  })
})

describe(`maxHeldValues caps the tail`, () => {
  it(`holds no more than the cap, dropping the longest-held first`, async () => {
    const { client, subscriptions } = makeClient()
    // A tail long enough that the deadline cannot be what retires anything.
    const collection = makeCollection(client, `cap`, {
      releaseAfterMs: 60_000,
      maxHeldValues: 2,
    })

    const reader = await ask(collection, [`page-reader`])
    for (const id of [`page-a`, `page-b`, `page-c`]) {
      await leave(await ask(collection, [id]))
    }

    // page-a was released first, so it is the one over the cap.
    expect(covered(subscriptions)).toEqual([`page-b`, `page-c`, `page-reader`])
    // And the value somebody is reading is not held, so the cap is no
    // threat to it.
    expect(reader.live.toArray).toHaveLength(1)
  })

  it(`counts only held values, so a cap of zero keeps a wanted value and nothing else`, async () => {
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `cap-zero`, {
      releaseAfterMs: 60_000,
      maxHeldValues: 0,
    })

    const reader = await ask(collection, [`page-reader`])
    await leave(await ask(collection, [`page-a`]))

    expect(covered(subscriptions)).toEqual([`page-reader`])
    expect(reader.live.toArray).toHaveLength(1)
  })
})
