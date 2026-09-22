// RouteRecord[] → an OpenAPI 3.1 document.

import type { RouteRecord, StandardSchemaV1 } from '@arcton/contracts'
import { pathParamNames, toOpenAPIPath } from './path'
import {
  createSchemaRegistry,
  type JsonSchema,
  type SchemaRegistry,
  toJsonSchema
} from './schema'

export interface OpenAPIInfo {
  title: string
  version: string
  description?: string
  [key: string]: unknown
}

export interface DocumentOptions {
  info: OpenAPIInfo
  servers?: Record<string, unknown>[]
  tags?: Record<string, unknown>[]
  security?: Record<string, unknown>[]
}

const JSON_MEDIA_TYPE = 'application/json'

// OpenAPI requires a description per response. These cover the codes a route
// is likely to declare; anything else gets a generic one rather than an
// invented meaning.
const STATUS_DESCRIPTIONS: Record<number, string> = {
  200: 'Successful response',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable entity',
  500: 'Internal server error'
}

// A schema with no JSON Schema representation still documents its shape in
// the structure around it (which parameters exist, which media type a body
// uses); only the value description is unknown, and `{}` is JSON Schema for
// exactly that.
function convert(
  schema: StandardSchemaV1,
  io: 'input' | 'output',
  registry: SchemaRegistry
): JsonSchema {
  const json = toJsonSchema(schema, io)
  return json ? registry.absorb(json) : {}
}

interface ObjectShape {
  properties: Map<string, JsonSchema>
  required: Set<string>
}

const EMPTY_SHAPE: ObjectShape = {
  properties: new Map(),
  required: new Set()
}

// params/query become one OpenAPI parameter per property, so only an object
// schema contributes anything. A schema that converts to something else (a
// union, or a `$ref` to a named object) still validates at runtime — it just
// can't be split into parameters here.
function objectShape(
  schema: StandardSchemaV1 | undefined,
  registry: SchemaRegistry
): ObjectShape {
  if (!schema) return EMPTY_SHAPE

  const json = toJsonSchema(schema, 'input')
  if (!json) return EMPTY_SHAPE

  const absorbed = registry.absorb(json)
  const properties = absorbed.properties
  if (typeof properties !== 'object' || properties === null) {
    return EMPTY_SHAPE
  }

  return {
    properties: new Map(
      Object.entries(properties as Record<string, JsonSchema>)
    ),
    required: new Set(
      Array.isArray(absorbed.required)
        ? absorbed.required.filter(
            (name): name is string => typeof name === 'string'
          )
        : []
    )
  }
}

function parameters(
  record: RouteRecord,
  registry: SchemaRegistry
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []

  // Path parameters come from the path itself, not from the schema — a route
  // documents every segment it declares, whether or not it validates them.
  const params = objectShape(record.params, registry)
  for (const name of pathParamNames(record.path)) {
    result.push({
      name,
      in: 'path',
      required: true,
      schema: params.properties.get(name) ?? {}
    })
  }

  const query = objectShape(record.query, registry)
  for (const [name, schema] of query.properties) {
    result.push({
      name,
      in: 'query',
      // Omitted when false — that's OpenAPI's own default for a parameter.
      ...(query.required.has(name) ? { required: true } : {}),
      schema
    })
  }

  return result
}

function requestBody(
  record: RouteRecord,
  registry: SchemaRegistry
): Record<string, unknown> | undefined {
  if (!record.body) return undefined
  return {
    required: true,
    content: {
      [JSON_MEDIA_TYPE]: { schema: convert(record.body, 'input', registry) }
    }
  }
}

function responses(
  record: RouteRecord,
  registry: SchemaRegistry
): Record<string, unknown> | undefined {
  if (!record.response) return undefined

  const result: Record<string, unknown> = {}
  for (const [status, schema] of Object.entries(record.response)) {
    const code = Number(status)
    const response: Record<string, unknown> = {
      description: STATUS_DESCRIPTIONS[code] ?? `Response ${status}`
    }
    // 204 promises no body, so a content schema would contradict the status.
    if (code !== 204) {
      response.content = {
        // 'output' — a response carries what a schema produces, which differs
        // from what it accepts wherever there's a transform.
        [JSON_MEDIA_TYPE]: { schema: convert(schema, 'output', registry) }
      }
    }
    result[status] = response
  }
  return result
}

function operation(
  record: RouteRecord,
  registry: SchemaRegistry
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const detail = record.detail

  if (detail?.operationId) result.operationId = detail.operationId
  if (detail?.summary) result.summary = detail.summary
  if (detail?.description) result.description = detail.description
  if (detail?.tags) result.tags = detail.tags
  if (detail?.deprecated) result.deprecated = detail.deprecated

  const params = parameters(record, registry)
  if (params.length > 0) result.parameters = params

  const body = requestBody(record, registry)
  if (body) result.requestBody = body

  const responded = responses(record, registry)
  if (responded) result.responses = responded

  return result
}

/**
 * Builds the OpenAPI 3.1 document for a set of route records.
 *
 * Routes with a wildcard segment are left out — see {@link toOpenAPIPath}.
 * WebSocket routes never reach here, having no record.
 */
export function buildDocument(
  records: readonly RouteRecord[],
  options: DocumentOptions
): Record<string, unknown> {
  const registry = createSchemaRegistry()
  const paths: Record<string, Record<string, unknown>> = {}

  for (const record of records) {
    const path = toOpenAPIPath(record.path)
    if (!path) continue

    const item = paths[path] ?? {}
    item[record.method.toLowerCase()] = operation(record, registry)
    paths[path] = item
  }

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: options.info
  }

  if (options.servers) document.servers = options.servers
  if (options.tags) document.tags = options.tags
  if (options.security) document.security = options.security

  document.paths = paths

  const schemas = registry.schemas()
  if (schemas) document.components = { schemas }

  return document
}
