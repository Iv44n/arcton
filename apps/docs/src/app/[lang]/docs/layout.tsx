import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { FileText, List } from 'lucide-react'
import Link from 'next/link'
import { baseOptions } from '@/lib/layout.shared'
import { source } from '@/lib/source'

function LlmLinks({ locale }: { locale: string }) {
  return (
    <div className="order-first mb-3 border-fd-border border-b pb-3">
      <p className="mb-1.5 px-2 font-medium text-fd-muted-foreground text-xs uppercase tracking-wider">
        {locale === 'es' ? 'Recursos' : 'Resources'}
      </p>
      <div className="flex flex-col gap-0.5">
        <Link
          href="/llms-full.txt"
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-fd-muted-foreground text-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">llms-full.txt</span>
        </Link>
        <Link
          href="/llms.txt"
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-fd-muted-foreground text-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          <List className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">llms.txt</span>
        </Link>
      </div>
    </div>
  )
}

export default async function Layout({
  params,
  children
}: LayoutProps<'/[lang]/docs'>) {
  const { lang } = await params

  return (
    <DocsLayout
      tree={source.getPageTree(lang)}
      sidebar={{ footer: <LlmLinks locale={lang} /> }}
      {...baseOptions(lang)}
    >
      {children}
    </DocsLayout>
  )
}
