// Route tree + registration.
//
// Three slots per node (static/dynamic/wildcard), not `children: RouteNode[]`
// — O(1) lookups by segment during matching. `insert` walks the parsed
// segments, creating nodes on demand (get-or-create), so registration order
// never affects the resulting tree shape.

import type { HttpMethod, RouteHandler } from '@arcton/contracts'
import type { ParsedRoute, Segment } from './parse'

export interface RouteNode {
  static: Map<string, RouteNode>
  dynamic?: { node: RouteNode; name: string }
  wildcard?: { node: RouteNode; name: string }
  handlers: Map<HttpMethod, RouteHandler>
}

export function createRouteNode(): RouteNode {
  return {
    static: new Map(),
    handlers: new Map()
  }
}

// Reconstructs a display path from segments for error messages — ParsedRoute
// doesn't retain the original string (see parse.ts).
function formatPath(segments: Segment[]): string {
  if (segments.length === 0) return '/'
  return `/${segments
    .map(segment => {
      if (segment.type === 'static') return segment.value
      if (segment.type === 'dynamic') return `:${segment.name}`
      return `*${segment.name}`
    })
    .join('/')}`
}

export function insert(
  root: RouteNode,
  parsed: ParsedRoute,
  method: HttpMethod,
  handler: RouteHandler
): void {
  let node = root

  for (const segment of parsed.segments) {
    if (segment.type === 'static') {
      let next = node.static.get(segment.value)
      if (!next) {
        next = createRouteNode()
        node.static.set(segment.value, next)
      }
      node = next
    } else if (segment.type === 'dynamic') {
      if (node.dynamic) {
        if (node.dynamic.name !== segment.name) {
          throw new Error(
            `Conflicting parameter name: "${segment.name}" conflicts with "${node.dynamic.name}" at same position`
          )
        }
      } else {
        node.dynamic = { node: createRouteNode(), name: segment.name }
      }
      node = node.dynamic.node
    } else {
      if (node.wildcard) {
        if (node.wildcard.name !== segment.name) {
          throw new Error(
            `Conflicting parameter name: "${segment.name}" conflicts with "${node.wildcard.name}" at same position`
          )
        }
      } else {
        node.wildcard = { node: createRouteNode(), name: segment.name }
      }
      node = node.wildcard.node
    }
  }

  if (node.handlers.has(method)) {
    throw new Error(
      `Duplicate route: ${method} ${formatPath(parsed.segments)} is already registered`
    )
  }
  node.handlers.set(method, handler)
}
