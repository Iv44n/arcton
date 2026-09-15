export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LevelWithSilent = LogLevel | 'silent'

// Ranks, not the levels themselves, are what ordering depends on — leaves
// room to insert a level later without renumbering everything downstream.
// 'silent' outranks every real level, so nothing at all passes `isEnabled`.
const RANK: Record<LevelWithSilent, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 70
}

export function isEnabled(level: LogLevel, minimum: LevelWithSilent): boolean {
  return RANK[level] >= RANK[minimum]
}
