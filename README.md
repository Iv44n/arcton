# arcton

Monorepo del framework Arcton, gestionado con Bun workspaces + Turborepo.

## Estructura

- `packages/core` — `@arcton/core`, el runtime del framework
- `packages/cli` — `@arcton/cli`, CLI (`arcton dev|start`)
- `packages/create-arcton` — scaffolding tool (`bunx create-arcton <dir>`)
- `apps/docs` — sitio de documentación
- `examples/basic` — app de ejemplo que consume `@arcton/core`

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
