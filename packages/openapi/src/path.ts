// Arcton route paths (`:id`, `*rest`) → OpenAPI template paths (`{id}`).

/**
 * The OpenAPI equivalent of an Arcton path, or `undefined` for a path OpenAPI
 * cannot express — a wildcard matches a variable number of segments, which
 * has no path-template form.
 */
export function toOpenAPIPath(path: string): string | undefined {
  const segments: string[] = []

  for (const segment of path.split('/')) {
    if (segment.length === 0) continue
    if (segment.startsWith('*')) return undefined
    segments.push(segment.startsWith(':') ? `{${segment.slice(1)}}` : segment)
  }

  return `/${segments.join('/')}`
}

/** The dynamic parameter names in an Arcton path, in order. */
export function pathParamNames(path: string): string[] {
  return path
    .split('/')
    .filter(segment => segment.startsWith(':'))
    .map(segment => segment.slice(1))
}
