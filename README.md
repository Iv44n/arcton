# arcton

Monorepo del framework Arcton, gestionado con Bun workspaces + Turborepo.

## Estructura

- `packages/core` — `@arcton/core`, el runtime del framework
- `packages/cli` — `arcton`, CLI unificado (`arcton create|dev|start`); el scaffolding vive acá, en `src/commands/create.ts` + `template/`
- `packages/create-arcton` — wrapper delgado sobre `arcton create`, solo para satisfacer la convención `npm create arcton` / `pnpm create arcton` / `bun create arcton`
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
