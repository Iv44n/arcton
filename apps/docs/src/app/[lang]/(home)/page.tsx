import type { Metadata } from 'next'
import { Features } from '@/components/home/features'
import { Hero } from '@/components/home/hero'
import { i18n } from '@/lib/i18n'
import { appName } from '@/lib/shared'

const copy = {
  en: {
    title: `${appName} — TypeScript backend framework`,
    description:
      'Backend framework for TypeScript with priority-based routing, native WebSockets, and a runtime-decoupled core you can extend with adapters.'
  },
  es: {
    title: `${appName} — Framework backend para TypeScript`,
    description:
      'Framework backend para TypeScript con enrutamiento basado en prioridad, WebSockets nativos y un núcleo desacoplado del runtime que puedes extender con adaptadores.'
  }
} as const

export default async function HomePage({ params }: PageProps<'/[lang]'>) {
  const { lang } = await params

  return (
    <>
      <Hero locale={lang} />
      <Features locale={lang} />
    </>
  )
}

export function generateStaticParams() {
  return i18n.languages.map(lang => ({ lang }))
}

export async function generateMetadata({
  params
}: PageProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await params
  const t = lang in copy ? copy[lang as keyof typeof copy] : copy.en

  return {
    title: t.title,
    description: t.description,
    alternates: {
      canonical: `/${lang}`,
      languages: Object.fromEntries(i18n.languages.map(l => [l, `/${l}`]))
    },
    openGraph: {
      type: 'website',
      siteName: appName,
      locale: lang,
      url: `/${lang}`,
      title: t.title,
      description: t.description
    },
    twitter: {
      card: 'summary_large_image',
      title: t.title,
      description: t.description
    }
  }
}
