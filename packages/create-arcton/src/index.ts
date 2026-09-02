#!/usr/bin/env bun
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import figlet from 'figlet'
import gradient from 'gradient-string'
import pc from 'picocolors'

const arcton = gradient(['#ef4444', '#fb923c'])
const banner = figlet.textSync('ARCTON').trimEnd()

console.log()
console.log(arcton.multiline(banner))
console.log()

p.intro(pc.bgRed(pc.black(' create-arcton ')))

const cliArg = Bun.argv[2]

const projectName =
  cliArg ??
  (await p.text({
    message: 'What is your project named?',
    placeholder: 'my-arcton-app',
    defaultValue: 'my-arcton-app',
    validate(value) {
      const name = value || 'my-arcton-app'
      if (!/^[a-z0-9._-]+$/i.test(name)) {
        return 'Use only letters, numbers, dots, dashes and underscores'
      }
    }
  }))

if (p.isCancel(projectName)) {
  p.cancel('Operation cancelled')
  process.exit(0)
}

const targetDir = resolve(process.cwd(), projectName)
const projectDirName = basename(targetDir)

if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
  const overwrite = await p.confirm({
    message: `${pc.yellow(projectDirName)} already exists and is not empty. Overwrite?`,
    initialValue: false
  })

  if (p.isCancel(overwrite) || !overwrite) {
    p.cancel('Operation cancelled')
    process.exit(0)
  }
}

const templateDir = fileURLToPath(new URL('../template', import.meta.url))

const scaffoldSpinner = p.spinner()
scaffoldSpinner.start('Creating project')

try {
  cpSync(templateDir, targetDir, { recursive: true })

  const pkgPath = `${targetDir}/package.json`
  const pkg = await Bun.file(pkgPath).json()
  pkg.name = projectDirName
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  scaffoldSpinner.stop('Project created')
} catch (error) {
  scaffoldSpinner.error('Failed to create project')
  p.cancel(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const shouldInstall = await p.confirm({
  message: 'Install dependencies now?',
  initialValue: true
})

let installed = false

if (!p.isCancel(shouldInstall) && shouldInstall) {
  const installSpinner = p.spinner()
  installSpinner.start('Installing dependencies')

  try {
    await Bun.$`bun install`.cwd(targetDir).quiet()
    installSpinner.stop('Dependencies installed')
    installed = true
  } catch {
    installSpinner.error('Failed to install dependencies')
  }
}

const isCurrentDir = targetDir === process.cwd()
const steps = [
  !isCurrentDir && `cd ${projectDirName}`,
  !installed && 'bun install',
  'bun run dev'
].filter(Boolean)

p.outro(`Next steps:\n\n${steps.map(step => pc.cyan(`  ${step}`)).join('\n')}`)
