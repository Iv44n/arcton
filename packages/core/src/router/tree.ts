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

function getOrCreateStaticChild(node: RouteNode, key: string): RouteNode {
  let next = node.static.get(key)
  if (!next) {
    next = createRouteNode()
    node.static.set(key, next)
  }
  return next
}

// A dynamic and a wildcard slot on the same node coexist fine (match.ts
// tries them in priority order) — only a same-slot name mismatch conflicts.
function getOrCreateDynamicChild(node: RouteNode, name: string): RouteNode {
  if (node.dynamic) {
    if (node.dynamic.name !== name) {
      throw new Error(
        `Conflicting parameter name: "${name}" conflicts with "${node.dynamic.name}" at same position`
      )
    }
  } else {
    node.dynamic = { node: createRouteNode(), name }
  }
  return node.dynamic.node
}

function getOrCreateWildcardChild(node: RouteNode, name: string): RouteNode {
  if (node.wildcard) {
    if (node.wildcard.name !== name) {
      throw new Error(
        `Conflicting parameter name: "${name}" conflicts with "${node.wildcard.name}" at same position`
      )
    }
  } else {
    node.wildcard = { node: createRouteNode(), name }
  }
  return node.wildcard.node
}

function assertNoHandlerConflict(
  node: RouteNode,
  method: HttpMethod,
  segments: Segment[]
): void {
  if (node.handlers.has(method)) {
    throw new Error(
      `Duplicate route: ${method} ${formatPath(segments)} is already registered`
    )
  }
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
      node = getOrCreateStaticChild(node, segment.value)
    } else if (segment.type === 'dynamic') {
      node = getOrCreateDynamicChild(node, segment.name)
    } else {
      node = getOrCreateWildcardChild(node, segment.name)
    }
  }

  assertNoHandlerConflict(node, method, parsed.segments)
  node.handlers.set(method, handler)
}

// `source` is left untouched (grafting doesn't consume it — it can be
// grafted into more than one `target`), and this reuses the exact same
// get-or-create/conflict primitives as `insert`, so a name clash or a
// duplicate (method, path) throws the same error either way.
export function graftTree(
  target: RouteNode,
  source: RouteNode,
  prefixSegments: Segment[],
  wrap: (handler: RouteHandler) => RouteHandler
): void {
  let node = target
  const pathSoFar: Segment[] = []

  for (const segment of prefixSegments) {
    if (segment.type !== 'static') {
      throw new Error(
        `Mount prefix must be a static path — got a "${segment.type}" segment`
      )
    }
    node = getOrCreateStaticChild(node, segment.value)
    pathSoFar.push(segment)
  }

  graftInto(node, source, pathSoFar, wrap)
}

function graftInto(
  target: RouteNode,
  source: RouteNode,
  pathSoFar: Segment[],
  wrap: (handler: RouteHandler) => RouteHandler
): void {
  for (const [method, handler] of source.handlers) {
    assertNoHandlerConflict(target, method, pathSoFar)
    target.handlers.set(method, wrap(handler))
  }

  for (const [key, childSource] of source.static) {
    const childTarget = getOrCreateStaticChild(target, key)
    graftInto(
      childTarget,
      childSource,
      [...pathSoFar, { type: 'static', value: key }],
      wrap
    )
  }

  if (source.dynamic) {
    const { node: childSource, name } = source.dynamic
    const childTarget = getOrCreateDynamicChild(target, name)
    graftInto(
      childTarget,
      childSource,
      [...pathSoFar, { type: 'dynamic', name }],
      wrap
    )
  }

  if (source.wildcard) {
    const { node: childSource, name } = source.wildcard
    const childTarget = getOrCreateWildcardChild(target, name)
    graftInto(
      childTarget,
      childSource,
      [...pathSoFar, { type: 'wildcard', name }],
      wrap
    )
  }
}
