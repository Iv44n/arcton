// Standard Schema → JSON Schema, plus the `$defs` → `components.schemas`
// hoisting that makes a shared schema appear once in the document.

import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@arcton/contracts'

export type JsonSchema = Record<string, unknown>

// OpenAPI 3.1 is a superset of JSON Schema draft 2020-12, so this is the
// target that needs no translation step. It's also the one the Standard JSON
// Schema spec asks implementers to support first — `openapi-3.0` is optional
// and ArkType, for one, throws on it.
const TARGET = 'draft-2020-12'

const DEFS_REF = '#/$defs/'
const COMPONENTS_REF = '#/components/schemas/'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The JSON Schema for a Standard Schema, or `undefined` when there isn't one
 * — either the library doesn't implement Standard JSON Schema (Valibot, until
 * wrapped with `toStandardJsonSchema`), or it does but this particular schema
 * has no representation (a transform on the way out, `z.date()`, ...), which
 * the spec signals by throwing.
 *
 * Documentation never decides whether an app can serve, so an absent schema
 * is a hole in the document, not an error.
 */
export function toJsonSchema(
  schema: StandardSchemaV1,
  io: 'input' | 'output'
): JsonSchema | undefined {
  const props: unknown = schema['~standard']
  if (!isRecord(props)) return undefined

  const converter = props.jsonSchema
  if (!isRecord(converter) || typeof converter[io] !== 'function') {
    return undefined
  }

  try {
    // Called as a method so an implementation relying on `this` still works.
    return (converter as unknown as StandardJSONSchemaV1.Converter)[io]({
      target: TARGET
    })
  } catch {
    return undefined
  }
}

// Also drops `$schema`: a document-level dialect declaration repeated inside
// every operation's schema is noise, and OpenAPI states the dialect itself.
function rewriteRefs(
  value: unknown,
  renames: ReadonlyMap<string, string>
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => rewriteRefs(item, renames))
  }
  if (!isRecord(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '$schema') continue

    if (
      key === '$ref' &&
      typeof item === 'string' &&
      item.startsWith(DEFS_REF)
    ) {
      const rest = item.slice(DEFS_REF.length)
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      const tail = slash === -1 ? '' : rest.slice(slash)
      result.$ref = `${COMPONENTS_REF}${renames.get(name) ?? name}${tail}`
      continue
    }

    result[key] = rewriteRefs(item, renames)
  }
  return result
}

export interface SchemaRegistry {
  /**
   * Moves a schema's `$defs` into the shared component set and returns the
   * schema with its `$ref`s pointing there instead.
   */
  absorb(schema: JsonSchema): JsonSchema
  /** The accumulated `components.schemas`, or `undefined` if empty. */
  schemas(): Record<string, JsonSchema> | undefined
}

export function createSchemaRegistry(): SchemaRegistry {
  const schemas: Record<string, JsonSchema> = {}
  // name → the definition as originally emitted, to tell a genuine reuse
  // (same name, same shape — the common case, since a library derives the
  // name from the schema itself) from two unrelated schemas that happen to
  // share a name.
  const sources = new Map<string, string>()

  return {
    absorb(schema) {
      const { $defs, ...rest } = schema
      if (!isRecord($defs)) {
        return rewriteRefs(rest, new Map()) as JsonSchema
      }

      const renames = new Map<string, string>()
      const added: [string, unknown][] = []

      for (const [name, definition] of Object.entries($defs)) {
        const source = JSON.stringify(definition)
        let target = name
        let attempt = 2
        while (sources.has(target) && sources.get(target) !== source) {
          target = `${name}${attempt++}`
        }
        renames.set(name, target)
        if (!sources.has(target)) {
          sources.set(target, source)
          added.push([target, definition])
        }
      }

      // Rewritten after every rename is known, so definitions referencing
      // each other resolve to the names they actually landed under.
      for (const [target, definition] of added) {
        schemas[target] = rewriteRefs(definition, renames) as JsonSchema
      }

      return rewriteRefs(rest, renames) as JsonSchema
    },

    schemas() {
      return Object.keys(schemas).length > 0 ? schemas : undefined
    }
  }
}
