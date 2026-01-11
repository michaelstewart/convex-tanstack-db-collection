import type { LoadSubsetOptions } from '@tanstack/db'
import type { ExtractedFilters, FilterDimension } from './types.js'
import { toKey } from './serialization.js'

/**
 * TanStack DB expression types (simplified for our needs)
 * These mirror the IR types from @tanstack/db
 */
interface PropRef {
  type: `ref`
  path: Array<string>
}

interface Value {
  type: `val`
  value: unknown
}

interface Func {
  type: `func`
  name: string
  args: Array<BasicExpression>
}

type BasicExpression = PropRef | Value | Func

/**
 * Check if a value is a PropRef expression
 */
function isPropRef(expr: unknown): expr is PropRef {
  return (
    typeof expr === `object` &&
    expr !== null &&
    `type` in expr &&
    expr.type === `ref` &&
    `path` in expr &&
    Array.isArray((expr as PropRef).path)
  )
}

/**
 * Check if a value is a Value expression
 */
function isValue(expr: unknown): expr is Value {
  return (
    typeof expr === `object` &&
    expr !== null &&
    `type` in expr &&
    expr.type === `val` &&
    `value` in expr
  )
}

/**
 * Check if a value is a Func expression
 */
function isFunc(expr: unknown): expr is Func {
  return (
    typeof expr === `object` &&
    expr !== null &&
    `type` in expr &&
    expr.type === `func` &&
    `name` in expr &&
    `args` in expr &&
    Array.isArray((expr as Func).args)
  )
}

/**
 * Check if a PropRef matches our target field.
 * Handles both aliased (e.g., ['msg', 'pageId']) and direct (e.g., ['pageId']) paths.
 */
function propRefMatchesField(propRef: PropRef, fieldName: string): boolean {
  const { path } = propRef
  // Direct field reference: ['pageId']
  if (path.length === 1 && path[0] === fieldName) {
    return true
  }
  // Aliased field reference: ['msg', 'pageId'] or ['m', 'pageId']
  if (path.length === 2 && path[1] === fieldName) {
    return true
  }
  return false
}

/**
 * Extract filter values from an 'eq' function call.
 * Pattern: eq(ref(filterField), val(x)) or eq(val(x), ref(filterField))
 */
function extractFromEq(func: Func, filterField: string): unknown[] {
  if (func.args.length !== 2) return []

  const [left, right] = func.args

  // eq(ref, val)
  if (isPropRef(left) && propRefMatchesField(left, filterField) && isValue(right)) {
    return [right.value]
  }

  // eq(val, ref) - reversed order
  if (isValue(left) && isPropRef(right) && propRefMatchesField(right, filterField)) {
    return [left.value]
  }

  return []
}

/**
 * Extract filter values from an 'in' function call.
 * Pattern: in(ref(filterField), val([a, b, c]))
 */
function extractFromIn(func: Func, filterField: string): unknown[] {
  if (func.args.length !== 2) return []

  const [left, right] = func.args

  // in(ref, val)
  if (isPropRef(left) && propRefMatchesField(left, filterField) && isValue(right)) {
    const val = right.value
    if (Array.isArray(val)) {
      return val
    }
  }

  return []
}

/**
 * Recursively walk an expression tree to find all filter values for the given field.
 * Handles 'eq', 'in', 'and', and 'or' expressions.
 */
function walkExpression(expr: unknown, filterField: string): unknown[] {
  if (!isFunc(expr)) return []

  const { name, args } = expr
  const results: unknown[] = []

  switch (name) {
    case `eq`:
      results.push(...extractFromEq(expr, filterField))
      break

    case `in`:
      results.push(...extractFromIn(expr, filterField))
      break

    case `and`:
    case `or`:
      // Recursively process all arguments
      for (const arg of args) {
        results.push(...walkExpression(arg, filterField))
      }
      break

    // For other functions, recursively check their arguments
    // (in case of nested expressions)
    default:
      for (const arg of args) {
        results.push(...walkExpression(arg, filterField))
      }
      break
  }

  return results
}

/**
 * Extract filter values from LoadSubsetOptions.
 *
 * Parses the `where` expression to find equality (`.eq()`) and set membership (`.in()`)
 * comparisons for the specified filter field.
 *
 * @param options - The LoadSubsetOptions from a live query
 * @param filterField - The field name to extract values for (e.g., 'pageId')
 * @returns Array of unique filter values found in the expression
 *
 * @example
 * // For query: where(m => m.pageId.eq('page-1'))
 * extractFilterValues(options, 'pageId') // returns ['page-1']
 *
 * @example
 * // For query: where(m => inArray(m.pageId, ['page-1', 'page-2']))
 * extractFilterValues(options, 'pageId') // returns ['page-1', 'page-2']
 *
 * @example
 * // For query: where(m => and(m.pageId.eq('page-1'), m.status.eq('active')))
 * extractFilterValues(options, 'pageId') // returns ['page-1']
 */
export function extractFilterValues(
  options: LoadSubsetOptions,
  filterField: string
): unknown[] {
  const { where } = options

  if (!where) {
    return []
  }

  // Extract from the where expression
  const values = walkExpression(where, filterField)

  // Return unique values using toKey for stable identity comparison
  const seen = new Set<string>()
  const unique: unknown[] = []
  for (const value of values) {
    const key = toKey(value)
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(value)
    }
  }

  return unique
}

/**
 * Check if LoadSubsetOptions contains a filter for the specified field.
 */
export function hasFilterField(options: LoadSubsetOptions, filterField: string): boolean {
  return extractFilterValues(options, filterField).length > 0
}

/**
 * Extract filter values for multiple filter dimensions from LoadSubsetOptions.
 *
 * Parses the `where` expression to find values for each configured filter dimension.
 * Results are keyed by convexArg for direct use in Convex query args.
 *
 * @param options - The LoadSubsetOptions from a live query
 * @param filterDimensions - Array of filter dimensions to extract
 * @returns Object mapping convexArg -> values for dimensions with matches
 *
 * @example
 * // For query: where(m => m.pageId.eq('page-1') && m.authorId.eq('user-1'))
 * extractMultipleFilterValues(options, [
 *   { filterField: 'pageId', convexArg: 'pageIds' },
 *   { filterField: 'authorId', convexArg: 'authorIds' },
 * ])
 * // returns { pageIds: ['page-1'], authorIds: ['user-1'] }
 */
export function extractMultipleFilterValues(
  options: LoadSubsetOptions,
  filterDimensions: FilterDimension[]
): ExtractedFilters {
  const result: ExtractedFilters = {}

  for (const dim of filterDimensions) {
    const values = extractFilterValues(options, dim.filterField)
    if (values.length > 0) {
      result[dim.convexArg] = values
    }
  }

  return result
}
