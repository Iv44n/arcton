import { afterEach, expect, test } from 'bun:test'

// Real subprocess, real SIGTERM — shutdown.test.ts covers the coordinator
// logic in isolation, this covers actual signal delivery end to end.
const fixturePath = `${import.meta.dir}/__fixtures__/shutdown-server.ts`

function createLineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  return {
    async nextLine(): Promise<string> {
      while (true) {
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          return line
        }
        const { value, done } = await reader.read()
        if (done) {
          throw new Error(
            `fixture process exited before printing an expected line (buffered: ${JSON.stringify(buffer)})`
          )
        }
        buffer += decoder.decode(value, { stream: true })
      }
    }
  }
}

let proc: ReturnType<typeof Bun.spawn> | undefined

afterEach(() => {
  if (proc && proc.exitCode === null) proc.kill()
  proc = undefined
})

test('SIGTERM drains an in-flight request before the process exits', async () => {
  proc = Bun.spawn(['bun', 'run', fixturePath], {
    stdout: 'pipe',
    stderr: 'inherit'
  })

  const lines = createLineReader(proc.stdout as ReadableStream<Uint8Array>)

  // listen()'s own startup banner prints before the fixture's PORT: line.
  let portLine = await lines.nextLine()
  while (!portLine.startsWith('PORT:')) {
    portLine = await lines.nextLine()
  }
  const port = Number(portLine.replace('PORT:', ''))
  expect(Number.isInteger(port)).toBe(true)

  const requestA = fetch(`http://localhost:${port}/slow`)

  // Proof request A reached the handler, instead of guessing with a sleep.
  expect(await lines.nextLine()).toBe('SLOW_STARTED')

  proc.kill('SIGTERM')
  // Lets the signal reach the handler before request B tries to connect.
  await new Promise(resolve => setTimeout(resolve, 20))

  const requestBOutcome = await fetch(`http://localhost:${port}/slow`).then(
    () => 'connected' as const,
    () => 'rejected' as const
  )
  expect(requestBOutcome).toBe('rejected')

  const resA = await requestA
  expect(resA.status).toBe(200)
  expect(await resA.json()).toEqual({ ok: true })
  const requestACompletedAt = Date.now()

  const exitCode = await proc.exited
  const exitedAt = Date.now()

  expect(exitCode).toBe(0)
  expect(exitedAt).toBeGreaterThanOrEqual(requestACompletedAt)
}, 10_000)
