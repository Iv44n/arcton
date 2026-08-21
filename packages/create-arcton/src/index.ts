#!/usr/bin/env bun
const targetDir = Bun.argv[2] ?? 'my-arcton-app'
const templateDir = new URL('../template', import.meta.url).pathname

await Bun.$`mkdir -p ${targetDir}`
await Bun.$`cp -r ${templateDir}/. ${targetDir}`

console.log(`Created ${targetDir}`)
console.log(`Next steps:`)
console.log(`  cd ${targetDir}`)
console.log(`  bun install`)
console.log(`  bun run dev`)
