// Public router entry point: wires parse + tree + match together into the
// `Router` shape core consumes.

import type {
  HttpMethod,
  MatchResult,
  RouteHandler,
  Router
} from '@arcton/contracts'
import { match as matchRoute } from './match'
import { parse } from './parse'
import { createRouteNode, insert as insertRoute, type RouteNode } from './tree'

export function createRouter(): Router & {
  insert(method: HttpMethod, path: string, handler: RouteHandler): void
  // Skips the URL parse `match(method, url)` does internally, for callers
  // that already have a `pathname` on hand (e.g. from a URL they parsed for
  // their own purposes, like reading `searchParams`) and would otherwise
  // parse the same request URL twice.
  matchPathname(method: HttpMethod, pathname: string): MatchResult
} {
  const root: RouteNode = createRouteNode()

  return {
    insert(method, path, handler) {
      insertRoute(root, parse(path), method, handler)
    },
    matchPathname(method, pathname) {
      return matchRoute(root, pathname, method)
    },
    match(method, url) {
      // "http://localhost" as base avoids relative-path bugs in tests —
      // match itself only ever looks at `pathname`.
      const { pathname } = new URL(url, 'http://localhost')
      return matchRoute(root, pathname, method)
    }
  }
}
