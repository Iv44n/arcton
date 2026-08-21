# lior

Monorepo del framework Lior, gestionado con Bun workspaces + Turborepo.

## Estructura

- `packages/core` — `@lior/core`, el runtime del framework
- `packages/cli` — `@lior/cli`, CLI (`lior dev|start`)
- `packages/create-lior` — scaffolding tool (`bunx create-lior <dir>`)
- `apps/docs` — sitio de documentación
- `examples/basic` — app de ejemplo que consume `@lior/core`

## Uso

Instalar dependencias:

```bash
bun install
```

Desarrollo (corre `dev` en todos los paquetes en paralelo vía Turborepo):

```bash
bun run dev
```

Build (type-check) de todos los paquetes:

```bash
bun run build
```

Tests:

```bash
bun run test
```

Cada paquete puede correrse individualmente, por ejemplo:

```bash
cd examples/basic
bun run dev
```
