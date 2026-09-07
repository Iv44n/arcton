export const appName = 'Arcton'
export const docsRoute = '/docs'
export const docsImageRoute = '/og/docs'
export const docsContentRoute = '/llms.mdx/docs'

// `VERCEL_URL`, which changes on every deployment), so canonical URLs and OG
// images stay pointed at the real site.
export const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'http://localhost:3000'

// fill this with your actual GitHub info, for example:
export const gitConfig = {
  user: 'Iv44n',
  repo: 'arcton',
  branch: 'main'
}
