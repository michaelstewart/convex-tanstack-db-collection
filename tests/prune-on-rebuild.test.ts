// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'

import {
  DEFAULT_RELEASE_AFTER_MS,
  convexCollectionOptions,
} from '../src/index.js'
import type { FunctionReference } from 'convex/server'
import type { ConvexClientLike } from '../src/types.js'

/**
 * A held value leaves the tail at the next rebuild of the subscription,
 * whatever prompted that rebuild. The one that used to be missed is the
 * cursor-advancement rebuild, which is the most common of the three in a
 * busy collection: the band a reader walked through rode across it
 * untouched, however long it had been released.
 */

type Row = { _id: string; pageId: string; updatedAt: number }

const fakeQuery = {} as FunctionReference<'query'>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const row = (id: string, pageId: string, updatedAt = 1): Row => ({
  _id: id,
  pageId,
  updatedAt,
})

// The debounce window is 50ms by default; this is comfortably past it.
const PAST_DEBOUNCE = 80
// The default number of rows that prompts a rebuild for the cursor.
const RESUBSCRIBE_THRESHOLD = 10

/** One subscription update carrying enough rows to trip that threshold. */
const rows = (pageId: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    row(`${pageId}-${i}`, pageId, 100 + i),
  )

function makeClient() {
  type Subscription = {
    pageIds: Array<string>
    after: unknown
    deliver: (rows: Array<Row>) => void
    open: boolean
  }
  const subscriptions: Array<Subscription> = []
  const client = {
    query: async (
      _fn: unknown,
      args: { pageIds?: Array<string> },
    ): Promise<Array<Row>> =>
      (args.pageIds ?? []).map((id) => row(`${id}-row`, id)),
    onUpdate: (
      _fn: unknown,
      args: { pageIds?: Array<string>; after?: unknown },
      onRows: (rows: Array<Row>) => void,
    ) => {
      const entry: Subscription = {
        pageIds: [...(args.pageIds ?? [])],
        after: args.after,
        deliver: onRows,
        open: true,
      }
      subscriptions.push(entry)
      return {
        unsubscribe: () => {
          entry.open = false
        },
      }
    },
  } as unknown as ConvexClientLike
  return { client, subscriptions }
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

function liveFor(
  collection: ReturnType<typeof makeCollection>,
  pageId: string,
) {
  const live = createLiveQueryCollection({
    startSync: true,
    query: (q) =>
      q.from({ t: collection }).where(({ t }) => eq(t.pageId, pageId)),
  })
  const subscription = live.subscribeChanges(() => {})
  return { live, subscription }
}

async function ask(
  collection: ReturnType<typeof makeCollection>,
  pageId: string,
) {
  const handle = liveFor(collection, pageId)
  await handle.live.preload()
  await sleep(PAST_DEBOUNCE)
  return handle
}

async function leave(handle: ReturnType<typeof liveFor>) {
  handle.subscription.unsubscribe()
  await handle.live.cleanup()
  await sleep(10)
}

describe(`a held value leaves at the next rebuild, whatever prompted it`, () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`the cursor-advancement rebuild drops the band, where it used to carry it across`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `cursor-rebuild`)
    const open = () => subscriptions.filter((s) => s.open)
    const covered = () => {
      const o = open()
      return o.length === 1 ? [...o[0]!.pageIds].sort() : null
    }

    // A band of three is walked through and left behind, and a page route
    // asks for its own page while the band is still inside its tail.
    const band = [await ask(collection, `a`), await ask(collection, `b`)]
    band.push(await ask(collection, `c`))
    for (const handle of band) await leave(handle)
    const reader = await ask(collection, `x`)
    expect(covered()).toEqual([`a`, `b`, `c`, `x`])

    // The band's tail runs out with nothing added: no batch, so no
    // add-driven rebuild, and the band is still in the argument.
    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS)
    expect(covered()).toEqual([`a`, `b`, `c`, `x`])

    // Then rows arrive on the tail for the page being read, and the
    // threshold prompts a rebuild to advance the cursor — a resubscribe
    // that was happening anyway. It used to rebuild with all four.
    const before = subscriptions.length
    open()[0]!.deliver(rows(`x`, RESUBSCRIBE_THRESHOLD + 2))
    await sleep(10)
    expect(subscriptions.length).toBeGreaterThan(before) // it did rebuild
    expect(covered()).toEqual([`x`])
    expect(reader.live.toArray.length).toBeGreaterThan(1)
  })

  it(`a release on its own still rebuilds nothing, however long the value has been held`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `release-is-free`)

    await ask(collection, `keep`)
    const going = await ask(collection, `go`)
    const before = subscriptions.length

    await leave(going)
    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS * 10)
    await sleep(PAST_DEBOUNCE)

    // No rebuild was provoked to narrow the tail: the value sits there,
    // costing nothing, until a rebuild happens for its own reasons.
    expect(subscriptions).toHaveLength(before)
    expect([...subscriptions.at(-1)!.pageIds].sort()).toEqual([`go`, `keep`])
  })

  it(`the rebuild that empties the tail closes the subscription rather than reopening it`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `rebuild-to-nothing`)
    const open = () => subscriptions.filter((s) => s.open)

    const only = await ask(collection, `a`)
    await leave(only)
    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS)

    // Rows for the held value still arrive — the tail still covers it —
    // and the rebuild they prompt finds nothing anybody wants.
    open()[0]!.deliver(rows(`a`, RESUBSCRIBE_THRESHOLD + 2))
    await sleep(10)
    expect(open()).toHaveLength(0)
  })

  it(`a value asked for again before a rebuild comes keeps its place and costs nothing`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, subscriptions } = makeClient()
    const collection = makeCollection(client, `revisit-before-rebuild`)
    const spy = vi.spyOn(client as unknown as { query: () => unknown }, `query`)

    await ask(collection, `keep`)
    await leave(await ask(collection, `a`))
    const before = subscriptions.length
    spy.mockClear()

    // Wanted again, inside its tail: nothing fetched, nothing rebuilt.
    const again = liveFor(collection, `a`)
    await again.live.preload()
    expect(again.live.toArray).toHaveLength(1)
    await sleep(PAST_DEBOUNCE)
    expect(spy).not.toHaveBeenCalled()
    expect(subscriptions).toHaveLength(before)

    // And a rebuild past what would have been its deadline keeps it, since
    // it is wanted rather than held.
    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS)
    await ask(collection, `b`)
    expect([...subscriptions.at(-1)!.pageIds].sort()).toEqual([
      `a`,
      `b`,
      `keep`,
    ])
  })
})
