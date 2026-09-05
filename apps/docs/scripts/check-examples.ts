#!/usr/bin/env bun
/**
 * Type-checks every TypeScript code block in the documentation.
 *
 * Each ```ts / ```tsx block is written to a scratch project whose tsconfig
 * maps the @arcton/* specifiers straight at the workspace sources, then the
 * whole project is checked in one `tsc` pass and any diagnostic is reported
 * against the .mdx file and line the block came from.
 *
 * A block whose info string contains `no-check` is skipped. A block with a
 * `title="name.ts"` is written under that name inside its page's folder, so
 * a page can show two files that import each other.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

const DOCS = resolve(SCRIPT_DIR, '..')
const REPO = resolve(DOCS, '../..')
const CONTENT = join(DOCS, 'content/docs')
const OUT = join(DOCS, '.docs-check')

interface Block {
  file: string // mdx path, relative to content/docs
  line: number // 1-based line of the opening fence
  lang: string
  code: string
  title?: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.mdx')) out.push(full)
  }
  return out
}

function extract(file: string, source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.split('\n')
  const rel = relative(CONTENT, file)

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const open = /^```(\w+)([^\n]*)$/.exec(line)

    if (!open) {
      i++
      continue
    }

    const lang = open[1] ?? ''
    const meta = open[2] ?? ''
    const start = i
    const body: string[] = []
    i++

    while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
      body.push(lines[i] ?? '')
      i++
    }
    i++ // closing fence

    if (lang !== 'ts' && lang !== 'tsx') continue
    if (meta.includes('no-check')) continue

    const title = /title="([^"]+)"/.exec(meta)?.[1]
    blocks.push({
      file: rel,
      line: start + 1,
      lang,
      code: body.join('\n'),
      title
    })
  }

  return blocks
}

const files = walk(CONTENT).sort()
const blocks = files.flatMap(file => extract(file, readFileSync(file, 'utf8')))

if (existsSync(OUT)) rmSync(OUT, { recursive: true })
mkdirSync(OUT, { recursive: true })

// generated file (relative to OUT) → source block
const map = new Map<string, Block>()

for (const [index, block] of blocks.entries()) {
  const pageDir = block.file.replace(/\.mdx$/, '').replace(/[^\w/-]/g, '_')
  const dir = join(OUT, pageDir)
  mkdirSync(dir, { recursive: true })

  const named = block.title && /\.tsx?$/.test(block.title) ? block.title : null
  let name = named ?? `block-${String(index).padStart(3, '0')}.${block.lang}`
  let attempt = 1
  while (existsSync(join(dir, name))) {
    const base = (named ?? `block-${index}`).replace(/\.tsx?$/, '')
    name = `${base}-${attempt}.${block.lang}`
    attempt++
  }

  const full = join(dir, name)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, `${block.code}\n`)
  map.set(relative(OUT, full), block)
}

writeFileSync(
  join(OUT, 'tsconfig.json'),
  `${JSON.stringify(
    {
      extends: relative(OUT, join(REPO, 'tsconfig.json')),
      compilerOptions: {
        noEmit: true,
        paths: {
          '@arcton/core': [
            relative(OUT, join(REPO, 'packages/core/src/index.ts'))
          ],
          '@arcton/contracts': [
            relative(OUT, join(REPO, 'packages/contracts/src/index.ts'))
          ],
          '@arcton/adapter-bun': [
            relative(OUT, join(REPO, 'packages/adapters/bun/src/index.ts'))
          ],
          '@arcton/adapter-node': [
            relative(OUT, join(REPO, 'packages/adapters/node/src/index.ts'))
          ],
          '@arcton/cors': [
            relative(OUT, join(REPO, 'packages/cors/src/index.ts'))
          ],
          valibot: [
            relative(OUT, join(REPO, 'examples/basic/node_modules/valibot'))
          ],
          zod: [relative(OUT, join(REPO, 'examples/basic/node_modules/zod'))]
        }
      },
      include: ['**/*.ts', '**/*.tsx']
    },
    null,
    2
  )}\n`
)

const result = spawnSync(
  'bunx',
  ['tsc', '--noEmit', '-p', join(OUT, 'tsconfig.json'), '--pretty', 'false'],
  { cwd: OUT, encoding: 'utf8' }
)

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
const diagnostics = output
  .split('\n')
  .filter(line => /\(\d+,\d+\): error TS/.test(line))

if (diagnostics.length === 0) {
  console.log(
    `check-examples: ${blocks.length} blocks in ${files.length} pages, 0 errors`
  )
  rmSync(OUT, { recursive: true })
  process.exit(0)
}

console.error(
  `check-examples: ${diagnostics.length} error(s) across ${blocks.length} blocks\n`
)

for (const diagnostic of diagnostics) {
  const match = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(diagnostic)
  if (!match) {
    console.error(diagnostic)
    continue
  }

  const [, generated = '', blockLine = '0', column = '0', message = ''] = match
  const block = map.get(generated.replace(/^\.\//, ''))

  if (!block) {
    console.error(`  ${diagnostic}`)
    continue
  }

  // +1 skips the opening fence, so the number points at the real source line
  const sourceLine = block.line + Number(blockLine)
  console.error(`  ${block.file}:${sourceLine}:${column}`)
  console.error(`    ${message}`)
  const offending = block.code.split('\n')[Number(blockLine) - 1]
  if (offending) console.error(`    | ${offending.trim()}`)
  console.error('')
}

console.error(`Scratch project kept at ${relative(REPO, OUT)} for inspection.`)
process.exit(1)
