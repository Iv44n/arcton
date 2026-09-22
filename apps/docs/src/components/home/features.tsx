import { Blocks, Layers, Puzzle, Radio, Route, ShieldCheck } from 'lucide-react'

const copy = {
  en: {
    heading: 'Everything a real API needs, nothing it doesn’t',
    features: [
      {
        icon: Route,
        title: 'Typed routing',
        description:
          'ctx.params is inferred from the route literal itself — no generic argument, no cast.'
      },
      {
        icon: Layers,
        title: 'An explicit pipeline',
        description:
          'Middleware composes in onion order, and a route only ever runs what was registered before it.'
      },
      {
        icon: ShieldCheck,
        title: 'Standard Schema validation',
        description:
          'Validate params, query and body with Zod, Valibot or ArkType — Arcton depends on none of them.'
      },
      {
        icon: Blocks,
        title: 'Runtime-decoupled core',
        description:
          '@arcton/core never imports Bun or Node.js. Pick a runtime as one option to listen().'
      },
      {
        icon: Radio,
        title: 'WebSockets, natively',
        description:
          'app.ws() registers a socket route on the same server as your HTTP routes.'
      },
      {
        icon: Puzzle,
        title: 'Modules that really merge',
        description:
          'Mount an Arcton instance into another and its route tree grafts in at registration — no nested router at request time.'
      }
    ]
  },
  es: {
    heading: 'Todo lo que necesita una API real, nada que no necesite',
    features: [
      {
        icon: Route,
        title: 'Enrutamiento tipado',
        description:
          'ctx.params se infiere del propio literal de la ruta — sin argumento genérico, sin cast.'
      },
      {
        icon: Layers,
        title: 'Un pipeline explícito',
        description:
          'El middleware se compone en orden onion, y una ruta solo corre lo que se registró antes que ella.'
      },
      {
        icon: ShieldCheck,
        title: 'Validation con Standard Schema',
        description:
          'Validá params, query y body con Zod, Valibot o ArkType — Arcton no depende de ninguno.'
      },
      {
        icon: Blocks,
        title: 'Núcleo desacoplado del runtime',
        description:
          '@arcton/core nunca importa Bun ni Node.js. Elegí un runtime como una opción de listen().'
      },
      {
        icon: Radio,
        title: 'WebSockets nativos',
        description:
          'app.ws() registra una ruta de socket en el mismo servidor que tus rutas HTTP.'
      },
      {
        icon: Puzzle,
        title: 'Módulos que se fusionan de verdad',
        description:
          'Montá una instancia de Arcton dentro de otra y su árbol de rutas se injerta al registrarse — sin router anidado en tiempo de request.'
      }
    ]
  }
} as const

export function Features({ locale }: { locale: string }) {
  const t = locale in copy ? copy[locale as keyof typeof copy] : copy.en

  return (
    <section className="border-fd-border border-b">
      <div className="mx-auto max-w-(--fd-layout-width) px-4 py-16 lg:py-20">
        <h2 className="text-center font-semibold text-2xl text-fd-foreground tracking-tight sm:text-3xl">
          {t.heading}
        </h2>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {t.features.map(feature => (
            <div
              key={feature.title}
              className="rounded-xl border border-fd-border bg-fd-card/50 p-6"
            >
              <div className="inline-flex size-10 items-center justify-center rounded-lg bg-linear-to-br from-red-500/15 to-orange-400/15 text-red-500 dark:text-red-400">
                <feature.icon className="size-5" />
              </div>
              <h3 className="mt-4 font-medium text-fd-foreground">
                {feature.title}
              </h3>
              <p className="mt-2 text-fd-muted-foreground text-sm">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
