// Route string → normalized structure.
//
// Pipeline (order is load-bearing):
//   1. validate the raw string (leading "/", no "//")
//   2. segment by "/", discarding empties (normalizes trailing slash)
//   3. classify each segment (static | dynamic | wildcard)
//   4. validate names, uniqueness, wildcard terminal-ness, static round-trip

export interface ParsedRoute {
  segments: Segment[]
}

// Static keeps its literal (raw, still-encoded) text so tree insertion can
// key a Map on it directly; dynamic/wildcard only need the param name.
export type Segment =
  | { type: 'static'; value: string }
  | { type: 'dynamic'; name: string }
  | { type: 'wildcard'; name: string }

const PARAM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/

function assertParamName(
  name: string,
  kind: 'dynamic' | 'wildcard',
  path: string
): void {
  if (!PARAM_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid ${kind} parameter name ":${name}" in route "${path}": ` +
        'must start with a letter and contain only letters, digits or "_"'
    )
  }
}

// A static segment is only predictable to match a request's (percent-encoded)
// pathname if it round-trips through URL.
function assertStaticRoundTrips(value: string, path: string): void {
  let pathname: string
  try {
    pathname = new URL(`http://x/${value}`).pathname
  } catch {
    throw new Error(
      `Invalid static segment "${value}" in route "${path}": not a valid URL path segment`
    )
  }
  if (pathname !== `/${value}`) {
    throw new Error(
      `Invalid static segment "${value}" in route "${path}": does not round-trip through URL`
    )
  }
}

export function parse(path: string): ParsedRoute {
  if (path.length === 0 || !path.startsWith('/')) {
    throw new Error(
      `Route path must start with "/", got ${JSON.stringify(path)}`
    )
  }
  if (path.includes('//')) {
    throw new Error(
      `Route path must not contain empty segments ("//"): "${path}"`
    )
  }

  const rawSegments = path.split('/').filter(raw => raw.length > 0)

  const segments: Segment[] = []
  const paramNames = new Set<string>()
  let sawWildcard = false

  for (const raw of rawSegments) {
    if (sawWildcard) {
      throw new Error(
        `Wildcard segment must be the last segment in route "${path}"`
      )
    }

    if (raw.startsWith(':')) {
      const name = raw.slice(1)
      assertParamName(name, 'dynamic', path)
      if (paramNames.has(name)) {
        throw new Error(`Duplicate parameter name "${name}" in route "${path}"`)
      }
      paramNames.add(name)
      segments.push({ type: 'dynamic', name })
    } else if (raw.startsWith('*')) {
      const name = raw.slice(1)
      assertParamName(name, 'wildcard', path)
      if (paramNames.has(name)) {
        throw new Error(`Duplicate parameter name "${name}" in route "${path}"`)
      }
      paramNames.add(name)
      segments.push({ type: 'wildcard', name })
      sawWildcard = true
    } else {
      assertStaticRoundTrips(raw, path)
      segments.push({ type: 'static', value: raw })
    }
  }

  return { segments }
}
