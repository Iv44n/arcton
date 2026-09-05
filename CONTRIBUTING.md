# Contributing to Arcton

This document is for people working **on** Arcton. If you are building an
application **with** Arcton, the documentation in
[`apps/docs`](apps/docs/content/docs) is what you want.

## Repository layout

Bun workspaces + Turborepo.

```text
packages/
├── core/            @arcton/core — Arcton(), routing, pipeline, response mapping
├── contracts/       @arcton/contracts — shared types, no runtime code
├── adapters/
│   ├── bun/         @arcton/adapter-bun
│   └── node/        @arcton/adapter-node
├── cors/            @arcton/cors
├── cli/             arcton — the CLI; scaffolding lives in src/commands/create.ts + template/
└── create-arcton/   thin wrapper so `npm create arcton` works
apps/
└── docs/            the documentation site (Next.js + Fumadocs)
examples/
└── basic/           an app exercising most of the framework
docs/                internal design notes
```

### Where things live in `core`

| Path | Responsibility |
|---|---|
| `src/index.ts` | `Arcton()`, the app surface, registration, `listen()` |
| `src/router/parse.ts` | route string → validated segments |
| `src/router/tree.ts` | the route tree, insertion, grafting for modules |
| `src/router/match.ts` | matching, priority and backtracking |
| `src/router/serialize.ts` | returned value → `Response` |
| `src/router/types.ts` | `ExtractParams`, the type-level route parser |
| `src/middleware/pipeline.ts` | the step sequence and its execution |
| `src/middleware/body.ts` | body parsing by `Content-Type` |

## Development setup

```bash
bun install
bun run dev     # every package in parallel
bun test        # the full suite
bun run build   # type-check and build all packages
bun run check   # Biome
```

A single package can be worked on directly:

```bash
cd examples/basic
bun run dev
```

## Testing

Tests use `bun test` and live beside the code they cover.

- `*.test.ts` — behavior. These are the specification: when the docs and the
  implementation disagree, the tests decide.
- `*.test-d.ts` — types. Checked by `tsc`, not by the test runner, so they only
  run as part of `bun run build`. `@ts-expect-error` marks a case that must
  *not* compile.

Serving in a test binds port `0` and reads the real port back:

```ts
import { expect, test } from 'bun:test'
import { Arcton } from '@arcton/core'

test('serves a route', async () => {
  const app = Arcton()
  app.get('/', () => ({ ok: true }))

  const server = app.listen({ port: 0 })
  const res = await fetch(server.url)

  expect(await res.json()).toEqual({ ok: true })

  server.stop()
})
```

Both an assertion about behavior and one about types are expected for a change
that touches the public API.

## Adding a feature

1. Decide whether it belongs in `core` or in a package of its own. Anything a
   user could write themselves as a middleware probably belongs beside
   `@arcton/cors`.
2. If it changes what a runtime must provide, the type goes in
   `@arcton/contracts` first, then both adapters implement it.
3. Add behavior tests, and type tests when the public API changes shape.
4. Update the documentation in `apps/docs/content/docs`, and run the
   documentation checks (below).
5. Registration-time errors should throw at registration, with a message that
   names the route or option involved.

## Adding an adapter

An adapter implements `RuntimeAdapter` from `@arcton/contracts` and nothing
else. It must:

- start a server on the requested port and hostname, and report the bound
  `port` and `url` — including the real port when `0` was requested;
- convert the runtime's native request into a `Request`, and write a
  `Response` back, headers and streaming body included;
- upgrade the WebSocket routes it is handed, when it declares the capability;
- catch anything thrown by the handler, log it, and answer `500`;
- do no routing of its own — every request goes to `options.fetch`.

`packages/adapters/*/src/index.test.ts` is the shared checklist: an adapter is
expected to pass the equivalent of all of those tests.

## Documentation

User documentation is MDX under `apps/docs/content/docs`, one folder per
section with a `meta.json` controlling order.

```bash
cd apps/docs
bun run dev

bun scripts/check-examples.ts      # type-checks every ts block against the workspace
bun scripts/check-links.ts         # resolves every internal link
bun scripts/check-api-coverage.ts  # diffs public exports against the API reference
```

All three must pass. `check-api-coverage` in particular fails when a public
export has no documentation, and when a page documents a symbol no package
exports.

Conventions: pages open with the use case rather than a signature, code blocks
are complete and runnable, links are relative paths ending in `.mdx`, and pages
describe what ships today. A block that is a pure type-signature display can be
marked `no-check` on its fence.

## Release process

Each publishable package builds with `tsc` for declarations plus `bun build`
for JavaScript, wired to `prepublishOnly`:

```bash
bun run build          # everything, through Turborepo
cd packages/core
bun publish
```

`@arcton/contracts` and the adapters must be published before a `core` release
that depends on new types in them. Versions are currently bumped by hand.

## Internal design notes

`docs/` holds working notes that are not user documentation — open design
questions and backlog. They are not a source of truth about what exists: the
code and the tests are.
