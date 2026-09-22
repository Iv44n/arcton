// Matching algorithm: priority-ordered recursive descent with backtracking.
//
// Priority per node is static → dynamic → wildcard, implemented as
// three ordered checks — each slot on RouteNode already encodes its own
// priority, so no explicit sort is needed.
//
// Terminal handling:
//   - handlers has this method         → matched, no backtrack.
//   - handlers non-empty, wrong method → methodNotAllowed, NO backtrack
//     (the most specific pattern that reaches terminal decides).
//   - no handlers at all (intermediate node) → null, backtrack.
//
// Backtracking undoes only the params it added for the abandoned branch
// — for both dynamic and wildcard.

import type { HttpMethod, MatchResult, RouteParams } from '@arcton/contracts'
import type { RouteNode } from './tree'

// decodeURIComponent throws on malformed percent-escapes (e.g. "%zz"); the
// raw segment is kept as a fallback instead of propagating the error.
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function matchNode(
  node: RouteNode,
  segments: string[],
  idx: number,
  method: HttpMethod,
  params: RouteParams
): MatchResult | null {
  if (idx === segments.length) {
    const handler = node.handlers.get(method)
    if (handler) {
      return { matched: true, handler, params }
    }
    if (node.handlers.size > 0) {
      return { methodNotAllowed: true, allowed: [...node.handlers.keys()] }
    }
    return null
  }

  // idx < segments.length is guaranteed by the check above; the guard below
  // only satisfies noUncheckedIndexedAccess.
  const seg = segments[idx]
  if (seg === undefined) return null

  const staticNode = node.static.get(seg)
  if (staticNode) {
    const result = matchNode(staticNode, segments, idx + 1, method, params)
    if (result !== null) return result
  }

  if (node.dynamic) {
    const { node: dynamicNode, name } = node.dynamic
    params[name] = decode(seg)
    const result = matchNode(dynamicNode, segments, idx + 1, method, params)
    if (result !== null) return result
    delete params[name]
  }

  if (node.wildcard) {
    const { node: wildcardNode, name } = node.wildcard
    params[name] = segments.slice(idx).map(decode).join('/')
    const handler = wildcardNode.handlers.get(method)
    if (handler) {
      return { matched: true, handler, params }
    }
    if (wildcardNode.handlers.size > 0) {
      return {
        methodNotAllowed: true,
        allowed: [...wildcardNode.handlers.keys()]
      }
    }
    delete params[name]
  }

  return null
}

// Discards every empty segment — trailing slash AND interior "//" collapse.
// Not decoded here: only the values captured into params are decoded, after
// matching.
function segmentPathname(pathname: string): string[] {
  return pathname.split('/').filter(segment => segment.length > 0)
}

export function match(
  root: RouteNode,
  pathname: string,
  method: HttpMethod
): MatchResult {
  const segments = segmentPathname(pathname)
  const result = matchNode(root, segments, 0, method, {})
  return result ?? { notFound: true }
}
