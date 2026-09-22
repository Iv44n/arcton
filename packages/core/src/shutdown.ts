import type { RuntimeServer } from '@arcton/contracts'

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

interface TrackedServer {
  server: RuntimeServer
  timeoutMs: number
}

export interface ShutdownCoordinator {
  /** Drains this server on SIGTERM/SIGINT. Returns an unregister function. */
  track(server: RuntimeServer, timeoutMs: number): () => void
  /** Test-only: tears down what this instance installed on `process`. */
  uninstall(): void
}

async function drainWithTimeout(
  server: RuntimeServer,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, timeoutMs)
  })

  try {
    await Promise.race([Promise.resolve(server.stop(false)), timeout])
  } finally {
    clearTimeout(timer)
  }

  if (timedOut) await server.stop(true)
}

export function createShutdownCoordinator(): ShutdownCoordinator {
  const tracked = new Set<TrackedServer>()
  // Latches true — a second SIGTERM/SIGINT must be a no-op, not a second drain.
  let shuttingDown = false
  let installed = false

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    const snapshot = [...tracked]
    tracked.clear()

    try {
      await Promise.all(
        snapshot.map(t => drainWithTimeout(t.server, t.timeoutMs))
      )
      process.exit(0)
    } catch (error) {
      console.error(error)
      process.exit(1)
    }
  }

  function ensureInstalled(): void {
    if (installed) return
    installed = true
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  }

  return {
    track(server, timeoutMs) {
      const entry: TrackedServer = { server, timeoutMs }
      tracked.add(entry)
      ensureInstalled()
      return () => tracked.delete(entry)
    },
    uninstall() {
      process.removeListener('SIGTERM', shutdown)
      process.removeListener('SIGINT', shutdown)
      tracked.clear()
      installed = false
      shuttingDown = false
    }
  }
}
