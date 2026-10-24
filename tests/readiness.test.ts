// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'

import {
  DEFAULT_RELEASE_AFTER_MS,
  convexCollectionOptions,
} from '../src/index.js'
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
  type Subscription = {
    pageIds?: Array<string>
    args: Record<string, unknown>
    deliver: (rows: Array<Row>) => void
  }
  const subscriptions: Array<Subscription> = []
  // The subscriptions still open: what the tail covers right now.
  const active: Array<Subscription> = []
  const client = {
    query: (_fn: unknown, args: { pageIds?: Array<string>; after?: unknown }) =>
      new Promise<Array<Row>>((resolve, reject) => {
        backfills.push({ args, resolve, reject })
      }),
    onUpdate: (
      _fn: unknown,
      args: { pageIds?: Array<string> } & Record<string, unknown>,
      onRows: (rows: Array<Row>) => void,
    ) => {
      // `deliver` plays rows in on the live subscription, as Convex would.
      const entry = { pageIds: args.pageIds, args, deliver: onRows }
      subscriptions.push(entry)
      active.push(entry)
      return {
        unsubscribe: () => {
          const index = active.indexOf(entry)
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
  options: { releaseAfterMs?: number; single?: boolean } = {},
) {
  return createCollection(
    convexCollectionOptions<FunctionReference<'query'>, Row, string>({
      id,
      client,
      query: fakeQuery,
      filters: options.single
        ? { filterField: `pageId`, convexArg: `pageId`, single: true }
        : { filterField: `pageId`, convexArg: `pageIds` },
      updatedAtFieldName: `updatedAt`,
      updatedAtType,
      releaseAfterMs: options.releaseAfterMs,
      getKey: (r) => r._id,
    }),
  )
}

// For the tests about catching a value up once it has left the tail: any
// add prunes a released value, so one fresh page is enough to get it out.
const PRUNE_AT_NEXT_ADD = { releaseAfterMs: 0 }

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

/** The query's requester goes away, as a route unmounting does. */
async function leave(handle: ReturnType<typeof liveFor>) {
  handle.subscription.unsubscribe()
  await handle.live.cleanup()
  await sleep(10)
}

/**
 * Asks for a page for the first time and lets its backfill land. Its batch
 * rebuilds the subscription, which is when released values are pruned.
 */
async function land(
  collection: ReturnType<typeof makeCollection>,
  backfills: ReturnType<typeof makeHeldClient>['backfills'],
  pageId: string,
  rows: Array<Row> = [row(`${pageId.toLowerCase()}1`, pageId)],
) {
  const handle = liveFor(collection, pageId)
  await sleep(PAST_DEBOUNCE)
  backfills.at(-1)!.resolve(rows)
  await handle.live.preload()
  return handle
}

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

  it(`a value pruned from the tail is ready again at once, and caught up from the cursor it was pruned at`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(
      client,
      `revisit`,
      `number`,
      PRUNE_AT_NEXT_ADD,
    )

    const first = await land(collection, backfills, `X`, [
      { ...row(`x1`, `X`), updatedAt: LANDED_AT },
    ])
    expect(first.live.toArray).toHaveLength(1)
    await leave(first)

    // Y's batch rebuilds the subscription, and X leaves it then.
    await land(collection, backfills, `Y`)
    expect(covered(active)).toEqual([`Y`])

    // Coming back, the rows are still there, so the query is ready without
    // waiting on anything — nothing has been released to it.
    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(1)

    // The catch-up behind it asks for what happened since, not for history.
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    expect(backfills[2]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
    backfills[2]!.resolve([
      { ...row(`x1`, `X`), updatedAt: LANDED_AT + 1 },
      { ...row(`x2`, `X`), updatedAt: LANDED_AT + 2 },
    ])
    await sleep(10)
    expect(second.toArray).toHaveLength(2)
    expect(covered(active)).toEqual([`X`, `Y`])
  })

  it(`a failed catch-up keeps what was shown, and is tried again on the next request`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(
      client,
      `revisit-offline`,
      `number`,
      PRUNE_AT_NEXT_ADD,
    )

    await leave(
      await land(collection, backfills, `X`, [
        { ...row(`x1`, `X`), updatedAt: LANDED_AT },
      ]),
    )
    await land(collection, backfills, `W`) // prunes X

    const secondHandle = liveFor(collection, `X`)
    const { live: second } = secondHandle
    await second.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    backfills[2]!.reject(new Error(`offline`))
    await sleep(PAST_DEBOUNCE)

    // Nobody was waiting on the catch-up's promise, so nothing fails on
    // screen — and its requester is still here, so the tail covers X from
    // now on rather than leaving a mounted query with no subscription.
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(1)
    expect(covered(active)).toEqual([`W`, `X`])

    // The gap behind it is still owed: the next request for X catches it
    // up again, from the same cursor — even though X never left the tail
    // in between, because the tail only covers it from the failure on.
    await leave(secondHandle)
    const thirdHandle = liveFor(collection, `X`)
    await thirdHandle.live.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(4)
    expect(backfills[3]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })

    // It fails again, the tail moves on past it on another page, and X is
    // released and then pruned. The tail's cursor says nothing about the
    // gap X still owes, so the prune keeps X's own cursor.
    backfills[3]!.reject(new Error(`offline`))
    await sleep(PAST_DEBOUNCE)
    active[0]!.deliver([{ ...row(`w2`, `W`), updatedAt: LANDED_AT * 5 }])
    await leave(thirdHandle)
    await land(collection, backfills, `V`) // prunes X
    expect(covered(active)).toEqual([`V`, `W`])

    liveFor(collection, `X`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(6)
    expect(backfills[5]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
  })

  it(`a fresh value that fails in the same window does not cost a caught-up value its subscription`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(
      client,
      `revisit-beside-failure`,
      `number`,
      PRUNE_AT_NEXT_ADD,
    )

    await leave(
      await land(collection, backfills, `X`, [
        { ...row(`x1`, `X`), updatedAt: LANDED_AT },
      ]),
    )
    await land(collection, backfills, `W`) // prunes X

    // X comes back and Y is asked for the first time, in one window: the
    // catch-up for X is issued beside the backfill for Y.
    const { live: second } = liveFor(collection, `X`)
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(4)
    expect(backfills[2]!.args).toEqual({
      pageIds: [`X`],
      after: CAUGHT_UP_FROM,
    })
    expect(backfills[3]!.args).toEqual({ pageIds: [`Y`], after: 0 })

    backfills[2]!.resolve([{ ...row(`x2`, `X`), updatedAt: LANDED_AT + 1 }])
    backfills[3]!.reject(new Error(`Y failed`))
    await sleep(PAST_DEBOUNCE)

    // Y fails as before; X is ready with its rows and the tail covers it.
    expect(liveY.status).toBe(`error`)
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(2)
    expect(covered(active)).toEqual([`W`, `X`])
  })

  // This used to keep X's old cursor, because a release took X out of the
  // tail before the subscription that would have covered it was built. A
  // release no longer takes anything out of the tail, so X is covered by
  // that subscription like any wanted value, and has nothing left to owe.
  it(`a value released while its catch-up is in flight stays in the tail, and owes nothing once it lands`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(
      client,
      `revisit-release-mid-flight`,
      `number`,
      PRUNE_AT_NEXT_ADD,
    )

    await leave(
      await land(collection, backfills, `X`, [
        { ...row(`x1`, `X`), updatedAt: LANDED_AT },
      ]),
    )
    await land(collection, backfills, `W`) // prunes X

    // X is asked for again beside a fresh Y, and Y lands first.
    const secondHandle = liveFor(collection, `X`)
    const { live: liveY } = liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(4)
    backfills[3]!.resolve([{ ...row(`y1`, `Y`), updatedAt: LANDED_AT * 5 }])
    await liveY.preload()

    // X's requester leaves while X's catch-up is still in flight.
    await leave(secondHandle)
    backfills[2]!.resolve([])
    await sleep(PAST_DEBOUNCE)
    expect(covered(active)).toEqual([`W`, `X`, `Y`])

    // The next request for X is ready with nothing to catch up.
    const { live: third } = liveFor(collection, `X`)
    await third.preload()
    await sleep(PAST_DEBOUNCE)
    expect(third.status).toBe(`ready`)
    expect(backfills).toHaveLength(4)
  })

  // This used to assert that X kept its old cursor of 10, for the same
  // reason as the test above: the release took X out of the tail before
  // the rebuilt subscription could cover it. Now X stays in, is covered,
  // and is stamped with the tail's cursor when it is finally pruned.
  it(`a value released before the tail covers it is stamped with the tail's cursor when pruned, not the one it came back with`, async () => {
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(
      client,
      `revisit-covered`,
      `int64`,
      PRUNE_AT_NEXT_ADD,
    )
    const ts = (n: number) => BigInt(n) as unknown as number

    // Z is held throughout, so a live subscription is always open.
    await land(collection, backfills, `Z`, [
      { ...row(`z1`, `Z`), updatedAt: ts(10) },
    ])

    // X lands at 20 and is released, then pruned by W's batch. Its own row
    // came by backfill, which never moves the shared cursor, so X is
    // stamped with the tail's 10.
    await leave(
      await land(collection, backfills, `X`, [
        { ...row(`x1`, `X`), updatedAt: ts(20) },
      ]),
    )
    await land(collection, backfills, `W`)

    // X comes back beside a slow fresh Y. X's catch-up lands first; the
    // batch — and the subscription that covers X — waits on Y.
    const secondHandle = liveFor(collection, `X`)
    liveFor(collection, `Y`)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(5)
    expect(backfills[3]!.args).toEqual({ pageIds: [`X`], after: 10n })
    backfills[3]!.resolve([])
    await sleep(10)

    // Meanwhile a Z row at 100 moves the global cursor on the live tail,
    // and X's requester leaves before Y has landed.
    active[0]!.deliver([{ ...row(`z2`, `Z`), updatedAt: ts(100) }])
    await leave(secondHandle)
    backfills[4]!.resolve([{ ...row(`y1`, `Y`), updatedAt: ts(30) }])
    await sleep(PAST_DEBOUNCE)
    expect(covered(active)).toEqual([`W`, `X`, `Y`, `Z`])

    // V's batch prunes X, which the tail has covered since that batch.
    await land(collection, backfills, `V`)
    expect(covered(active)).toEqual([`V`, `W`, `Y`, `Z`])

    const { live: third } = liveFor(collection, `X`)
    await third.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(7)
    expect(backfills[6]!.args).toEqual({ pageIds: [`X`], after: 100n })
  })

  it(`a commit-timestamp cursor is passed to the catch-up unchanged`, async () => {
    const { client, backfills } = makeHeldClient()
    const collection = makeCollection(
      client,
      `revisit-int64`,
      `int64`,
      PRUNE_AT_NEXT_ADD,
    )
    const landedAt = 20_000n as unknown as number

    await leave(
      await land(collection, backfills, `X`, [
        { ...row(`x1`, `X`), updatedAt: landedAt },
      ]),
    )
    await land(collection, backfills, `W`) // prunes X

    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    // No overlap rewind: a commit timestamp is an exact lower bound.
    expect(backfills[2]!.args).toEqual({ pageIds: [`X`], after: 20_000n })
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

describe(`a released value stays in the tail until an add prunes it`, () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(`releasing the only requester of a value leaves the subscription alone`, async () => {
    const { client, backfills, subscriptions, active } = makeHeldClient()
    const collection = makeCollection(client, `held`)

    const x = await land(collection, backfills, `X`)
    expect(subscriptions).toHaveLength(1)

    await leave(x)
    await sleep(PAST_DEBOUNCE)
    expect(subscriptions).toHaveLength(1) // nothing new opened
    expect(active).toEqual([subscriptions[0]]) // and nothing closed
    expect(covered(active)).toEqual([`X`])
  })

  it(`a value asked for again while it is held is ready at once, loading and resubscribing nothing`, async () => {
    const { client, backfills, subscriptions, active } = makeHeldClient()
    const collection = makeCollection(client, `held-revisit`)

    await leave(await land(collection, backfills, `X`))

    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    expect(second.status).toBe(`ready`)
    expect(second.toArray).toHaveLength(1)

    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(1)
    expect(subscriptions).toHaveLength(1)
    expect(covered(active)).toEqual([`X`])
  })

  it(`an add after the threshold rebuilds the subscription once, without the value, which is caught up from where the tail had reached`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, backfills, subscriptions, active } = makeHeldClient()
    const collection = makeCollection(client, `held-expired`)

    await leave(
      await land(collection, backfills, `X`, [
        { ...row(`x1`, `X`), updatedAt: LANDED_AT },
      ]),
    )

    // The tail delivers an X row at 30_000 while X is held: it is covered,
    // so this is where the tail had reached when X is pruned.
    active[0]!.deliver([{ ...row(`x2`, `X`), updatedAt: LANDED_AT + 10_000 }])

    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS)
    await land(collection, backfills, `Y`)
    expect(subscriptions).toHaveLength(2)
    expect(covered(active)).toEqual([`Y`])

    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    expect(second.toArray).toHaveLength(2)
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(3)
    expect(backfills[2]!.args).toEqual({
      pageIds: [`X`],
      // The 30_000 the tail had delivered, rewound by the 10s overlap.
      after: LANDED_AT,
    })
  })

  it(`an add before the threshold rebuilds the subscription once, keeping the held value`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, backfills, subscriptions, active } = makeHeldClient()
    const collection = makeCollection(client, `held-fresh`)

    await leave(await land(collection, backfills, `X`))

    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS - 1)
    await land(collection, backfills, `Y`)
    expect(subscriptions).toHaveLength(2)
    expect(covered(active)).toEqual([`X`, `Y`])

    // Still held, so asking again costs nothing.
    const { live: second } = liveFor(collection, `X`)
    await second.preload()
    await sleep(PAST_DEBOUNCE)
    expect(backfills).toHaveLength(2)
    expect(subscriptions).toHaveLength(2)
  })

  it(`a value asked for again while held is wanted again, and a later add does not prune it`, async () => {
    vi.useFakeTimers({ toFake: [`Date`] })
    const { client, backfills, active } = makeHeldClient()
    const collection = makeCollection(client, `held-wanted-again`)

    await leave(await land(collection, backfills, `X`))
    liveFor(collection, `X`) // and it stays mounted

    // Past the threshold since X was released, but X has a requester now.
    vi.setSystemTime(Date.now() + DEFAULT_RELEASE_AFTER_MS)
    await land(collection, backfills, `Y`)
    expect(covered(active)).toEqual([`X`, `Y`])
  })

  it(`in a single-valued dimension, a different value displaces a held one whatever its age`, async () => {
    const { client, backfills, subscriptions, active } = makeHeldClient()
    const collection = makeCollection(client, `held-single`, `number`, {
      single: true,
    })

    await leave(await land(collection, backfills, `X`))
    expect(active.map((s) => s.args.pageId)).toEqual([`X`])

    // Long before the threshold, Y is asked for. X must not count against
    // the one value the dimension allows, and must leave the tail, which
    // can carry one value only.
    const y = await land(collection, backfills, `Y`)
    expect(y.live.status).toBe(`ready`)
    expect(subscriptions).toHaveLength(2)
    expect(active.map((s) => s.args.pageId)).toEqual([`Y`])
  })
})
