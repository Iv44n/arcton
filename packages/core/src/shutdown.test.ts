import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import type { RuntimeServer } from '@arcton/contracts'
import { createShutdownCoordinator } from './shutdown'

function fakeServer(overrides: Partial<RuntimeServer> = {}): RuntimeServer {
  return {
    port: 0,
    url: new URL('http://localhost:0'),
    stop: mock(() => undefined),
    ...overrides
  }
}

// Fresh instance per test; torn down in afterEach since the listeners it installs are real.
let coordinator: ReturnType<typeof createShutdownCoordinator> | undefined

afterEach(() => {
  coordinator?.uninstall()
  coordinator = undefined
})

function emitSignal(): void {
  process.emit('SIGTERM')
}

// A single microtask tick isn't enough to drain shutdown()'s own await chain.
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

test('track() installs SIGTERM/SIGINT listeners on first call only', () => {
  const beforeTerm = process.listenerCount('SIGTERM')
  const beforeInt = process.listenerCount('SIGINT')
  coordinator = createShutdownCoordinator()

  coordinator.track(fakeServer(), 1000)
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1)
  expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1)

  coordinator.track(fakeServer(), 1000)
  coordinator.track(fakeServer(), 1000)
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1)
  expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1)
})

test('a signal calls stop(false) on every tracked server', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never
  )
  coordinator = createShutdownCoordinator()

  const serverA = fakeServer()
  const serverB = fakeServer()
  coordinator.track(serverA, 1000)
  coordinator.track(serverB, 1000)

  emitSignal()
  await flush()

  expect(serverA.stop).toHaveBeenCalledWith(false)
  expect(serverB.stop).toHaveBeenCalledWith(false)
  expect(exit).toHaveBeenCalledWith(0)

  exit.mockRestore()
})

test('a second signal while shutting down is a no-op', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never
  )
  coordinator = createShutdownCoordinator()

  const server = fakeServer()
  coordinator.track(server, 1000)

  emitSignal()
  emitSignal()
  await flush()

  expect(server.stop).toHaveBeenCalledTimes(1)

  exit.mockRestore()
})

test('stop(true) is forced once shutdownTimeout elapses, without re-racing it', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never
  )
  coordinator = createShutdownCoordinator()

  const stopCalls: Array<boolean | undefined> = []
  const server = fakeServer({
    stop: mock((closeActiveConnections?: boolean) => {
      stopCalls.push(closeActiveConnections)
      // simulates a request that never finishes draining
      return closeActiveConnections ? undefined : new Promise<void>(() => {})
    })
  })

  coordinator.track(server, 10)

  emitSignal()
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(stopCalls).toEqual([false, true])
  expect(exit).toHaveBeenCalledWith(0)

  exit.mockRestore()
})

test('process.exit(1) when a drain rejects', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never
  )
  const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined)
  coordinator = createShutdownCoordinator()

  const server = fakeServer({
    stop: mock(() => Promise.reject(new Error('stop boom')))
  })
  coordinator.track(server, 1000)

  emitSignal()
  await flush()

  expect(exit).toHaveBeenCalledWith(1)

  exit.mockRestore()
  errorSpy.mockRestore()
})

test('the untrack function removes a server so a later signal skips it', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never
  )
  coordinator = createShutdownCoordinator()

  const server = fakeServer()
  const untrack = coordinator.track(server, 1000)
  untrack()

  emitSignal()
  await flush()

  expect(server.stop).not.toHaveBeenCalled()
  expect(exit).toHaveBeenCalledWith(0)

  exit.mockRestore()
})

test('multiple tracked servers: untracking one still drains the rest on signal', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(
    () => undefined as never
  )
  coordinator = createShutdownCoordinator()

  const serverA = fakeServer()
  const serverB = fakeServer()
  const untrackA = coordinator.track(serverA, 1000)
  coordinator.track(serverB, 1000)

  untrackA()
  emitSignal()
  await flush()

  expect(serverA.stop).not.toHaveBeenCalled()
  expect(serverB.stop).toHaveBeenCalledWith(false)

  exit.mockRestore()
})
