#!/usr/bin/env bun
/**
 * Diffs the public exports of every published package against what the API
 * reference documents.
 *
 * Reports both directions: an export that no api/ page mentions, and a symbol
 * an api/ page presents as public that no package exports. The first means a
 * gap; the second means an invented API.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

const DOCS = resolve(SCRIPT_DIR, '..')
const REPO = resolve(DOCS, '../..')
const API = join(DOCS, 'content/docs/api')

const ENTRYPOINTS: Record<string, string> = {
  '@arcton/core': 'packages/core/src/index.ts',
  '@arcton/contracts': 'packages/contracts/src/index.ts',
  '@arcton/adapter-bun': 'packages/adapters/bun/src/index.ts',
  '@arcton/adapter-node': 'packages/adapters/node/src/index.ts',
  '@arcton/cors': 'packages/cors/src/index.ts'
}

// Members of the app and context objects, documented as part of their parent
// rather than as standalone exports
const MEMBERS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'ws',
  'use',
  'provide',
  'parser',
  'listen',
  'config',
  'request',
  'params',
  'query',
  'response',
  'body',
  'status',
  'headers',
  'send',
  'close',
  'stop',
  'url',
  'port',
  'name',
  'version',
  'capabilities',
  'serve',
  'handler',
  'middleware',
  'message',
  'open',
  'drain',
  'next',
  'upgrade',
  'fetch',
  'hostname',
  'env',
  'adapter',
  'prefix',
  'websocket',
  'data',
  'issues',
  'path',
  'origin',
  'methods',
  'credentials',
  'maxAge',
  'preflight',
  'allowedHeaders',
  'exposedHeaders'
])

function exportsOf(source: string): string[] {
  const names = new Set<string>()

  const declaration =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|function|const|let|var|class|namespace|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(declaration)) {
    if (match[1]) names.add(match[1])
  }

  const reExport = /^export\s+(?:type\s+)?\{([^}]+)\}/gm
  for (const match of source.matchAll(reExport)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (name) names.add(name)
    }
  }

  return [...names]
}

const exported = new Map<string, string>() // symbol → package
for (const [pkg, relativePath] of Object.entries(ENTRYPOINTS)) {
  const source = readFileSync(join(REPO, relativePath), 'utf8')
  for (const name of exportsOf(source)) exported.set(name, pkg)
}

const pages = readdirSync(API).filter(file => file.endsWith('.mdx'))
const corpus = pages
  .map(file => readFileSync(join(API, file), 'utf8'))
  .join('\n')

const missing = [...exported.entries()].filter(
  ([name]) => !new RegExp(`\\b${name}\\b`).test(corpus)
)

// Symbols an api/ page presents in a heading, which should all be real exports
const documented = new Set<string>()
for (const file of pages) {
  const source = readFileSync(join(API, file), 'utf8')
  // Only a backticked heading names an API symbol; prose headings are plain text
  for (const match of source.matchAll(
    /^#{2,3}\s+`([A-Za-z_$][\w$.]*)(?:\(\))?`\s*$/gm
  )) {
    const heading = match[1]
    if (!heading) continue
    const base = heading.split('.').pop()
    if (base) documented.add(base)
  }
}

const invented = [...documented].filter(
  name => !exported.has(name) && !MEMBERS.has(name)
)

let failed = false

if (missing.length > 0) {
  failed = true
  console.error(
    `check-api-coverage: ${missing.length} export(s) not documented\n`
  )
  for (const [name, pkg] of missing) console.error(`  ${pkg}  ${name}`)
  console.error('')
}

if (invented.length > 0) {
  failed = true
  console.error(
    `check-api-coverage: ${invented.length} documented symbol(s) with no matching export\n`
  )
  for (const name of invented) console.error(`  ${name}`)
  console.error('')
}

if (failed) process.exit(1)

console.log(
  `check-api-coverage: ${exported.size} public exports across ${Object.keys(ENTRYPOINTS).length} packages, all documented`
)
