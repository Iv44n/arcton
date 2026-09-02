import { Hero } from '@/components/home/hero'

export default async function HomePage({ params }: PageProps<'/[lang]'>) {
  const { lang } = await params

  return <Hero locale={lang} />
}
