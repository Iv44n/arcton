import { spawn } from 'node:child_process'
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import figlet from 'figlet'
import gradient from 'gradient-string'
import pc from 'picocolors'

// Walks up to the nearest package.json — bundling changes this file's depth.
function findPackageRoot(startDir: string): string {
  let dir = startDir
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not find package.json above ${startDir}`)
    }
    dir = parent
  }
  return dir
}

type Runtime = 'bun' | 'node'
type PackageManager = 'bun' | 'pnpm' | 'npm'

const INSTALL_COMMAND: Record<PackageManager, string> = {
  bun: 'bun install',
  pnpm: 'pnpm install',
  npm: 'npm install'
}

const RUN_DEV_COMMAND: Record<PackageManager, string> = {
  bun: 'bun run dev',
  pnpm: 'pnpm run dev',
  npm: 'npm run dev'
}

// shell: true on Windows so npm/pnpm/bun's .cmd shims resolve.
function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32'
    })
    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', code =>
      code === 0
        ? resolvePromise()
        : reject(
            new Error(stderr.trim() || `${command} exited with code ${code}`)
          )
    )
  })
}

// Resolves "latest" to a pinned version — pnpm has a confirmed bug with the literal string.
async function resolveLatestVersions(
  pkg: Record<string, unknown>
): Promise<void> {
  const lookups: Promise<void>[] = []

  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[section] as Record<string, string> | undefined
    if (!deps) continue

    for (const [name, version] of Object.entries(deps)) {
      if (version !== 'latest') continue
      lookups.push(
        fetch(`https://registry.npmjs.org/${name}/latest`)
          .then(res => res.json() as Promise<{ version: string }>)
          .then(data => {
            deps[name] = `^${data.version}`
          })
      )
    }
  }

  await Promise.all(lookups)
}

export async function runCreate(argv: string[]): Promise<void> {
  const banner = figlet.textSync('ARCTON').trimEnd()
  const arctonGradient = gradient(['#ef4444', '#fb923c'])

  console.log()
  console.log(arctonGradient.multiline(banner))
  console.log()

  p.intro(pc.bgRed(pc.black(' arcton create ')))

  const cliArg = argv[0]

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

  const runtime = await p.select<Runtime>({
    message: 'Runtime',
    options: [
      { value: 'bun', label: 'Bun' },
      { value: 'node', label: 'Node.js' }
    ]
  })

  if (p.isCancel(runtime)) {
    p.cancel('Operation cancelled')
    process.exit(0)
  }

  const packageManager = await p.select<PackageManager>({
    message: 'Package manager',
    options: [
      { value: 'bun', label: 'bun' },
      { value: 'pnpm', label: 'pnpm' },
      { value: 'npm', label: 'npm' }
    ],
    initialValue: runtime === 'bun' ? 'bun' : 'npm'
  })

  if (p.isCancel(packageManager)) {
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

  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)))
  const templateDir = join(packageRoot, 'template', runtime)

  const scaffoldSpinner = p.spinner()
  scaffoldSpinner.start('Creating project')

  try {
    cpSync(templateDir, targetDir, { recursive: true })

    const pkgPath = `${targetDir}/package.json`
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    pkg.name = projectDirName
    await resolveLatestVersions(pkg)
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

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
      const [command, ...args] = INSTALL_COMMAND[packageManager].split(' ')
      await run(command as string, args, targetDir)
      installSpinner.stop('Dependencies installed')
      installed = true
    } catch (error) {
      installSpinner.error('Failed to install dependencies')
      p.log.error(error instanceof Error ? error.message : String(error))
    }
  }

  const isCurrentDir = targetDir === process.cwd()
  const steps = [
    !isCurrentDir && `cd ${projectDirName}`,
    !installed && INSTALL_COMMAND[packageManager],
    RUN_DEV_COMMAND[packageManager]
  ].filter(Boolean)

  p.outro(
    `Next steps:\n\n${steps.map(step => pc.cyan(`  ${step}`)).join('\n')}`
  )
}
