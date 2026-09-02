import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { uiTranslations } from 'fumadocs-ui/i18n'
import { Logo } from '@/components/logo'
import { i18n } from './i18n'
import { docsRoute, gitConfig } from './shared'

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    en: {
      displayName: 'English'
    },
    es: {
      displayName: 'Español',
      'Ask AI(AI chat button)': 'Preguntar a la IA',
      'Back to Home(404 not found page)': 'Volver al inicio',
      'Choose a language(language switcher)': 'Elegir idioma',
      'Choose a language(language switcher)(aria-label)': 'Elegir idioma',
      'Close Banner(banner)(aria-label)': 'Cerrar aviso',
      'Close Search(search dialog)(aria-label)': 'Cerrar búsqueda',
      'Close Sidebar(aria-label)': 'Cerrar barra lateral',
      'Close Sidebar(sidebar)(aria-label)': 'Cerrar barra lateral',
      'Collapse Sidebar(sidebar)(aria-label)': 'Contraer barra lateral',
      'Copied Text(code block)(aria-label)': 'Texto copiado',
      'Copy Anchor Link(heading anchor)(aria-label)': 'Copiar enlace',
      'Copy Link(accordion)(aria-label)': 'Copiar enlace',
      'Copy Markdown(page actions)': 'Copiar Markdown',
      'Copy Text(code block)(aria-label)': 'Copiar texto',
      'Dark(theme switcher)(aria-label)': 'Oscuro',
      'Default(type table)': 'Predeterminado',
      'Edit on GitHub(edit page)': 'Editar en GitHub',
      'Hide Sidebar(sidebar)': 'Ocultar barra lateral',
      'Last updated on(page footer)': 'Última actualización el',
      'Layout Tab(layout tab trigger)': 'Pestaña de diseño',
      'Light(theme switcher)(aria-label)': 'Claro',
      'Next Page(pagination)': 'Página siguiente',
      'No Headings(table of contents)': 'Sin encabezados',
      'No results found(search dialog)': 'No se encontraron resultados',
      'On this page(table of contents)': 'En esta página',
      'Open Search(search trigger)(aria-label)': 'Abrir búsqueda',
      'Open Sidebar(aria-label)': 'Abrir barra lateral',
      'Open Sidebar(sidebar)(aria-label)': 'Abrir barra lateral',
      'Open in ChatGPT(page actions)': 'Abrir en ChatGPT',
      'Open in Claude(page actions)': 'Abrir en Claude',
      'Open in Cursor(page actions)': 'Abrir en Cursor',
      'Open in GitHub(page actions)': 'Abrir en GitHub',
      'Open in Scira AI(page actions)': 'Abrir en Scira AI',
      'Open(page actions)': 'Abrir',
      'Page Not Found(404 not found page)': 'Página no encontrada',
      'Parameters(type table)': 'Parámetros',
      'Previous Page(pagination)': 'Página anterior',
      'Prop(type table)': 'Propiedad',
      'Read {url}, I want to ask questions about it.(page actions)':
        'Lee {url}, quiero hacer preguntas sobre ello.',
      'Returns(type table)': 'Devuelve',
      'Search(search dialog)': 'Buscar',
      'Search(search trigger)': 'Buscar',
      'Show Sidebar(sidebar)': 'Mostrar barra lateral',
      'System(theme switcher)(aria-label)': 'Sistema',
      'Table of Contents(inline table of contents)': 'Tabla de contenidos',
      'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 not found page)':
        'La página que buscas pudo haber sido eliminada, haber cambiado de nombre o no estar disponible temporalmente.',
      'Toggle Menu(home layout header)(aria-label)': 'Alternar menú',
      'Toggle Theme(theme switcher)(aria-label)': 'Alternar tema',
      'Type(type table)': 'Tipo',
      'View as Markdown(page actions)': 'Ver como Markdown'
    }
  })

export function baseOptions(locale: string): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: <Logo />,
      url: `/${locale}`
    },
    links: [
      {
        text: locale === 'es' ? 'Documentación' : 'Documentation',
        url: `/${locale}${docsRoute}`,
        active: 'nested-url'
      }
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`
  }
}
