#!/usr/bin/env node
import { runCreate } from 'arcton/create'

// Exists only to satisfy the npm/pnpm/bun "create-<name>" convention.
await runCreate(process.argv.slice(2))
