#!/usr/bin/env bun
import { cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const targetDir = Bun.argv[2] ?? 'my-arcton-app'
const templateDir = fileURLToPath(new URL('../template', import.meta.url))

cpSync(templateDir, targetDir, { recursive: true })

console.log(`Created ${targetDir}`)
console.log(`Next steps:`)
console.log(`  cd ${targetDir}`)
console.log(`  bun install`)
console.log(`  bun run dev`)
