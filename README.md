<div align="center">

# Arcton

**A TypeScript backend framework, structured for real applications.**

Priority-based routing · typed context · runtime-decoupled core

[Documentation](apps/docs/content/docs) · [Getting started](#getting-started) · pre-1.0

</div>

## What is Arcton?

Arcton is a backend framework for TypeScript. Handlers return values instead of
calling response methods, middleware composes in the order you register it, and
an application is assembled from modules that merge into a single route tree.

```ts
import { Arcton } from '@arcton/core'

const app = Arcton()

app.get('/', () => ({ message: 'Welcome to Arcton' }))

app.get('/users/:id', ctx => ({ id: ctx.params.id }))

app.listen({ port: 3000 })
```

`ctx.params.id` is typed as `string` because the route literal says so — no
generic argument, no cast.

## Why Arcton?

- **Types from what you wrote.** Route literals type `ctx.params`, schemas type
  `ctx.body`, and `provide()` widens the context for everything after it.
- **Order you can read.** A route runs the middleware registered before it, so
  the file behaves the way it reads.
- **A router with defined precedence.** Static beats dynamic beats wildcard,
  with backtracking, independent of registration order.
- **Validation without a lock-in.** Params, query and body accept any
  [Standard Schema](https://standardschema.dev/) — Zod, Valibot, ArkType.
- **Runtime-decoupled.** The core imports neither Bun nor Node.js; the runtime
  is an argument to `listen()`.
- **Modules that really merge.** Mounting grafts a module's routes into the
  parent tree at registration, so nesting costs nothing per request.

## Getting started

```bash
bun create arcton
```

The scaffold asks for a runtime (Bun or Node.js) and a package manager, then
writes a project you can run immediately:

```bash
cd my-arcton-app
bun run dev
```

To add Arcton to an existing project:

```bash
bun add @arcton/core
```

## Your first server

```ts
import { Arcton } from '@arcton/core'
import * as v from 'valibot'

const app = Arcton()

app.get('/health', () => ({ status: 'ok' }))

app.post('/echo', {
  body: v.object({ message: v.string() }),
  handler: ctx => ({ echoed: ctx.body.message })
})

app.listen({ port: 3000 })
```

Running on Node.js is one option away:

```ts
import { nodeAdapter } from '@arcton/adapter-node'

app.listen({ adapter: nodeAdapter })
```

## Documentation

Full documentation lives in [`apps/docs`](apps/docs) and covers routing,
middleware, validation, providers, modules, testing, architecture and the
complete API reference.

```bash
cd apps/docs
bun run dev
```

## Packages

| Package | Description |
|---|---|
| `@arcton/core` | the framework: `Arcton()`, routing, middleware, validation |
| `@arcton/contracts` | shared types, including the `RuntimeAdapter` interface |
| `@arcton/adapter-bun` | serves an Arcton app on Bun |
| `@arcton/adapter-node` | serves an Arcton app on Node.js |
| `@arcton/cors` | CORS middleware |
| `arcton` | CLI — `arcton create` |

## Status

Arcton is **pre-1.0**. The API is in active development and can change between
releases; pin your dependencies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout, development
setup, testing conventions and release process.
