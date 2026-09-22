#!/usr/bin/env bun
/**
 * Verifies every internal documentation link.
 *
 * Pages link to each other with relative file paths ending in .mdx, which
 * `createRelativeLink` resolves at render time. This checks that each of those
 * paths points at a page that exists, that every heading anchor exists, and
 * that no page uses an absolute /docs URL (which would bypass the locale
 * prefix).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

const CONTENT = resolve(SCRIPT_DIR, '../content/docs')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.mdx')) out.push(full)
  }
  return out
}

// GitHub-style heading slug, matching how the docs renderer generates anchors
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

const files = walk(CONTENT).sort()

const anchors = new Map<string, Set<string>>()
for (const file of files) {
  const set = new Set<string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line)
    if (heading?.[1]) set.add(slugify(heading[1]))
  }
  anchors.set(file, set)
}

interface Problem {
  file: string
  line: number
  href: string
  reason: string
}

const problems: Problem[] = []
let checked = 0

for (const file of files) {
  const rel = relative(CONTENT, file)
  const lines = readFileSync(file, 'utf8').split('\n')

  for (const [index, line] of lines.entries()) {
    const hrefs = [
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]),
      ...[...line.matchAll(/href="([^"]+)"/g)].map(match => match[1])
    ].filter((href): href is string => href !== undefined)

    for (const href of hrefs) {
      if (/^(https?:|mailto:)/.test(href)) continue

      checked++

      if (href.startsWith('#')) {
        const anchor = href.slice(1)
        if (!anchors.get(file)?.has(anchor)) {
          problems.push({
            file: rel,
            line: index + 1,
            href,
            reason: 'anchor not found on this page'
          })
        }
        continue
      }

      if (href.startsWith('/')) {
        problems.push({
          file: rel,
          line: index + 1,
          href,
          reason: 'absolute link — use a relative path ending in .mdx'
        })
        continue
      }

      const [path = '', anchor] = href.split('#')
      const target = resolve(dirname(file), path)

      if (!path.endsWith('.mdx')) {
        problems.push({
          file: rel,
          line: index + 1,
          href,
          reason: 'relative link must point at a .mdx file'
        })
        continue
      }

      let exists = true
      try {
        statSync(target)
      } catch {
        exists = false
      }

      if (!exists) {
        problems.push({
          file: rel,
          line: index + 1,
          href,
          reason: `target does not exist (${relative(CONTENT, target)})`
        })
        continue
      }

      if (anchor && !anchors.get(target)?.has(anchor)) {
        problems.push({
          file: rel,
          line: index + 1,
          href,
          reason: `anchor "#${anchor}" not found in ${relative(CONTENT, target)}`
        })
      }
    }
  }
}

if (problems.length === 0) {
  console.log(
    `check-links: ${checked} internal links across ${files.length} pages, 0 broken links`
  )
  process.exit(0)
}

console.error(
  `check-links: ${problems.length} broken link(s) of ${checked} checked\n`
)
for (const problem of problems) {
  console.error(`  ${problem.file}:${problem.line}  ${problem.href}`)
  console.error(`    ${problem.reason}\n`)
}
process.exit(1)
