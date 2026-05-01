// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db'

import { convexCollectionOptions } from '../src/index.js'
import { ConvexSyncManager } from '../src/ConvexSyncManager.js'
import type { FunctionReference } from 'convex/server'
import type { ConvexClientLike } from '../src/types.js'

type Page = {
  _id: string
  workspaceId: string
  updatedAt: number
  [key: string]: unknown
}

/**
 * Minimal ConvexClient stand-in: returns the data the test feeds it for the
 * one-shot `client.query` (used for backfill) and serves a no-op subscription
 * for the live tail (used after backfill).
 */
function makeFakeClient(rows: Array<Page>): ConvexClientLike {
  return {
    query: () => Promise.resolve(rows),
    onUpdate: () => ({
      unsubscribe: () => {},
    }),
  } as unknown as ConvexClientLike
}

const fakeQuery = {} as FunctionReference<'query'>

describe(`ConvexSyncManager — empty backfill`, () => {
  it(`commits an empty transaction when global backfill returns []`, async () => {
    const calls: Array<string> = []
    const manager = new ConvexSyncManager<Page, string>({
      client: makeFakeClient([]),
      query: fakeQuery,
      filterDimensions: [],
      updatedAtFieldName: `updatedAt`,
      debounceMs: 0,
      tailOverlapMs: 0,
      resubscribeThreshold: 0,
      getKey: (p) => p._id,
    })
    manager.setCallbacks({
      collection: { get: () => undefined, has: () => false },
      begin: () => calls.push(`begin`),
      write: () => calls.push(`write`),
      commit: () => calls.push(`commit`),
      markReady: () => calls.push(`markReady`),
    })

    await manager.requestFilters({})

    // The fix: an empty backfill must still produce a begin/commit pair so
    // @tanstack/db ≥ 0.6.x's LiveQueryCollection sees a status nudge.
    expect(calls).toEqual([`begin`, `commit`, `markReady`])
  })

  it(`commits an empty transaction when filter backfill returns []`, async () => {
    const calls: Array<string> = []
    const manager = new ConvexSyncManager<Page, string>({
      client: makeFakeClient([]),
      query: fakeQuery,
      filterDimensions: [
        { filterField: `workspaceId`, convexArg: `workspaceId` },
      ],
      updatedAtFieldName: `updatedAt`,
      debounceMs: 0,
      tailOverlapMs: 0,
      resubscribeThreshold: 0,
      getKey: (p) => p._id,
    })
    manager.setCallbacks({
      collection: { get: () => undefined, has: () => false },
      begin: () => calls.push(`begin`),
      write: () => calls.push(`write`),
      commit: () => calls.push(`commit`),
      markReady: () => calls.push(`markReady`),
    })

    await manager.requestFilters({ workspaceId: [`ws_empty`] })

    expect(calls).toEqual([`begin`, `commit`, `markReady`])
  })
})

describe(`useLiveQuery-shaped readiness — empty backfill`, () => {
  // Repro for the hang described in the bug report: a LiveQueryCollection
  // built on top of a Convex-backed collection whose backing query returns []
  // must reach `ready` instead of staying in loadingSubset forever.
  it(
    `live query reaches ready when underlying Convex query returns []`,
    { timeout: 5000 },
    async () => {
      const pages = createCollection(
        convexCollectionOptions<FunctionReference<'query'>, Page, string>({
          id: `pages-empty`,
          client: makeFakeClient([]),
          query: fakeQuery,
          filters: { filterField: `workspaceId`, convexArg: `workspaceId` },
          updatedAtFieldName: `updatedAt`,
          getKey: (p) => p._id,
        }),
      )

      const live = createLiveQueryCollection({
        startSync: true,
        query: (q) =>
          q
            .from({ page: pages })
            .where(({ page }) => eq(page.workspaceId, `ws_empty`))
            .orderBy(({ page }) => page.updatedAt, `desc`),
      })

      const result = await live.toArrayWhenReady()
      expect(result).toEqual([])
      expect(live.status).toBe(`ready`)
    },
  )

  it(
    `live query resolves with rows when underlying Convex query returns data`,
    { timeout: 5000 },
    async () => {
      const row: Page = {
        _id: `p1`,
        workspaceId: `ws_full`,
        updatedAt: 100,
      }
      const pages = createCollection(
        convexCollectionOptions<FunctionReference<'query'>, Page, string>({
          id: `pages-full`,
          client: makeFakeClient([row]),
          query: fakeQuery,
          filters: { filterField: `workspaceId`, convexArg: `workspaceId` },
          updatedAtFieldName: `updatedAt`,
          getKey: (p) => p._id,
        }),
      )

      const live = createLiveQueryCollection({
        startSync: true,
        query: (q) =>
          q
            .from({ page: pages })
            .where(({ page }) => eq(page.workspaceId, `ws_full`))
            .orderBy(({ page }) => page.updatedAt, `desc`),
      })

      const result = await live.toArrayWhenReady()
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject(row)
      expect(live.status).toBe(`ready`)
    },
  )
})

describe(`convexCollectionOptions — loadSubset contract`, () => {
  // Locks in the contract from Fix B: loadSubset must always return a
  // non-thenable so @tanstack/db ≥ 0.6.x's LiveQueryCollection takes the
  // non-Promise branch in onLoadSubsetResult and doesn't gate readiness on
  // pendingLoadSubsetPromises (which doesn't reliably drain on empty data).
  function callLoadSubsetForBranches(
    filters: Parameters<typeof convexCollectionOptions>[0]['filters'],
    where: unknown,
  ) {
    const options = convexCollectionOptions({
      client: makeFakeClient([]),
      query: fakeQuery,
      filters,
      updatedAtFieldName: `updatedAt`,
      getKey: (p) => (p as Page)._id,
    })

    // Drive the sync function with stub callbacks so we can grab loadSubset.
    const stubParams = {
      collection: { get: () => undefined, has: () => false },
      begin: () => {},
      write: () => {},
      commit: () => {},
      markReady: () => {},
      truncate: () => {},
    }
    const result = (options.sync as { sync: (p: unknown) => unknown }).sync(
      stubParams,
    ) as { loadSubset: (opts: unknown) => unknown }

    return result.loadSubset({ where })
  }

  it(`returns true (not a Promise) for the 0-filter branch`, () => {
    const ret = callLoadSubsetForBranches(undefined, undefined)
    expect(ret).toBe(true)
  })

  it(`returns true (not a Promise) for the empty-where filter branch`, () => {
    const ret = callLoadSubsetForBranches(
      { filterField: `workspaceId`, convexArg: `workspaceId` },
      undefined,
    )
    expect(ret).toBe(true)
  })

  it(`returns true (not a Promise) for the populated-where filter branch`, () => {
    // where: eq(workspaceId, 'ws_1')
    const where = {
      type: `func`,
      name: `eq`,
      args: [
        { type: `ref`, path: [`workspaceId`] },
        { type: `val`, value: `ws_1` },
      ],
    }
    const ret = callLoadSubsetForBranches(
      { filterField: `workspaceId`, convexArg: `workspaceId` },
      where,
    )
    expect(ret).toBe(true)
  })
})
