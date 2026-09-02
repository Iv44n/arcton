import { DynamicLink } from 'fumadocs-core/dynamic-link'
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock'
import { ArrowRight } from 'lucide-react'
import { docsRoute } from '@/lib/shared'
import { CopyCommand } from './copy-command'

const code = `import { Arcton } from '@arcton/core'

const app = Arcton({ port: 3000 })

app.get('/', () => ({ message: 'Welcome to Arcton' }))
app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))

app.ws('/chat', {
  message(ws, msg) {
    ws.send(\`echo: \${msg}\`)
  }
})

app.listen()
`

const copy = {
  en: {
    badge: 'pre-1.0 · TypeScript backend framework',
    titleLine1: 'Structured by design.',
    titleLine2Prefix: 'Fast by',
    titleHighlight: 'default',
    description:
      'Arcton is a backend framework for TypeScript, structured for real applications — priority-based routing, native WebSockets, and a runtime-decoupled core you can extend through adapters, without the ceremony.',
    cta: 'Get Started'
  },
  es: {
    badge: 'pre-1.0 · Framework backend para TypeScript',
    titleLine1: 'Estructurado por diseño.',
    titleLine2Prefix: 'Rápido por',
    titleHighlight: 'defecto',
    description:
      'Arcton es un framework backend para TypeScript, estructurado para aplicaciones reales — enrutamiento basado en prioridad, WebSockets nativos y un núcleo desacoplado del runtime que puedes extender mediante adaptadores, sin ceremonias.',
    cta: 'Comenzar'
  }
} as const

export function Hero({ locale }: { locale: string }) {
  const t = locale in copy ? copy[locale as keyof typeof copy] : copy.en

  return (
    <section className="relative overflow-hidden border-fd-border border-b">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-dot-grid opacity-[0.06]"
        style={{
          maskImage:
            'radial-gradient(ellipse 80% 60% at 60% 0%, black, transparent)'
        }}
      />
      <div
        aria-hidden
        className="-top-32 pointer-events-none absolute right-[-10%] -z-10 size-140 rounded-full bg-red-500/25 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-40 right-24 -z-10 size-90 rounded-full bg-orange-400/20 blur-[110px]"
      />

      <div className="mx-auto grid max-w-(--fd-layout-width) gap-12 px-4 py-20 lg:grid-cols-2 lg:items-center lg:py-28">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 font-mono text-red-500 text-xs dark:text-red-400">
            <span className="size-1.5 rounded-full bg-red-500" />
            {t.badge}
          </div>

          <h1 className="mt-6 text-4xl font-semibold text-fd-foreground tracking-tight sm:text-5xl">
            {t.titleLine1}
            <br />
            {t.titleLine2Prefix}{' '}
            <span className="bg-linear-to-r from-red-500 to-orange-400 bg-clip-text text-transparent">
              {t.titleHighlight}
            </span>
            .
          </h1>

          <p className="mt-5 max-w-md text-fd-muted-foreground">
            {t.description}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <DynamicLink
              href={`/[lang]${docsRoute}`}
              className="inline-flex items-center gap-2 rounded-full bg-red-500 px-5 py-2.5 font-medium text-white transition-colors hover:bg-red-600"
            >
              {t.cta}
              <ArrowRight className="size-4" />
            </DynamicLink>
            <CopyCommand command="bun create arcton" />
          </div>
        </div>

        <DynamicCodeBlock
          lang="ts"
          code={code}
          codeblock={{
            title: 'index.ts',
            className: 'my-0 shadow-2xl shadow-black/40'
          }}
        />
      </div>
    </section>
  )
}
