import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware'
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation'
import type { NextFetchEvent } from 'next/server'
import { type NextRequest, NextResponse } from 'next/server'
import { i18n } from '@/lib/i18n'
import { docsContentRoute, docsRoute } from '@/lib/shared'

const i18nProxy = createI18nMiddleware(i18n)

const { rewrite: rewriteDocs } = rewritePath(
  `/:lang${docsRoute}{/*path}`,
  `/:lang${docsContentRoute}{/*path}/content.md`
)
const { rewrite: rewriteSuffix } = rewritePath(
  `/:lang${docsRoute}{/*path}.md`,
  `/:lang${docsContentRoute}{/*path}/content.md`
)

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const result = rewriteSuffix(request.nextUrl.pathname)
  if (result) {
    return NextResponse.rewrite(new URL(result, request.nextUrl))
  }

  if (isMarkdownPreferred(request)) {
    const result = rewriteDocs(request.nextUrl.pathname)

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl), {
        // this URL has two representations, selected by `Accept`
        headers: { Vary: 'Accept' }
      })
    }
  }

  return i18nProxy(request, event)
}

export const config = {
  // Matcher ignoring `/_next/`, `/api/` and static assets in `/public`
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
}
