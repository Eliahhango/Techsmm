import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const SITE_ROOT = new URL('site/techsmm.com/', window.location.href).pathname

function sourceForPath(pathname, search = '') {
  if (pathname === '/' || pathname === '') return 'index.html'
  const clean = pathname.replace(/^\/+/, '').replace(/^Techsmm\//i, '')
  if (clean === 'blog') {
    const page = new URLSearchParams(search).get('page')
    if (page && /^\d+(?:\.html)?$/.test(page)) return `blog-page-${page.replace(/\.html$/, '')}.html`
  }
  return clean.endsWith('.html') ? clean : `${clean}.html`
}

function localAsset(url) {
  if (!url) return url
  if (url.startsWith('/site/')) return url
  url = url.replace(/^\/techsmm\.com\/services\.html\//, '/')
  const value = url.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '').replace(/^\.\//, '').replace(/^(\.\.\/)+/, '')
  if (value.startsWith('storage.') || value.startsWith('cdn.') || value.startsWith('cdnjs.') || value.startsWith('code.') || value.startsWith('unpkg.')) {
    return `/site/${value}`
  }
  return url
}

function Page() {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [styles, setStyles] = useState([])
  const [title, setTitle] = useState('TechSMM')
  const source = useMemo(() => sourceForPath(window.location.pathname, window.location.search), [window.location.pathname, window.location.search])

  useEffect(() => {
    let cancelled = false
    setError('')
    fetch(`${SITE_ROOT}${source}`)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        return response.text()
      })
      .then((markup) => {
        if (cancelled) return
        const document = new DOMParser().parseFromString(markup, 'text/html')
        setTitle(document.title || 'TechSMM')
        document.body.querySelectorAll('img[src],script[src],source[src],video[src],audio[src],iframe[src]').forEach((node) => {
          const original = node.getAttribute('src')
          const local = localAsset(original)
          if (local !== original) node.setAttribute('src', local)
        })
        const stylesheetUrls = [...document.querySelectorAll('link[rel="stylesheet"]')]
          .map((link) => localAsset(link.getAttribute('href')))
          .filter(Boolean)
        const inlineStyles = [...document.querySelectorAll('style')].map((style) => style.textContent)
        setStyles([...stylesheetUrls, ...inlineStyles.map((value) => `inline:${value}`)])
        setHtml(document.body?.innerHTML || markup)
      })
      .catch((reason) => !cancelled && setError(`Page not found: ${source} (${reason.message})`))
    return () => { cancelled = true }
  }, [source])

  useEffect(() => {
    document.title = title
    const added = []
    styles.forEach((value) => {
      if (value.startsWith('inline:')) {
        const node = document.createElement('style')
        node.textContent = value.slice(7)
        document.head.appendChild(node)
        added.push(node)
      } else {
        const node = document.createElement('link')
        node.rel = 'stylesheet'
        node.href = value
        document.head.appendChild(node)
        added.push(node)
      }
    })
    return () => added.forEach((node) => node.remove())
  }, [styles, title])

  function navigate(event) {
    const anchor = event.target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || /^https?:\/\//i.test(href)) return
    event.preventDefault()
    const target = new URL(href, `${window.location.origin}/${source}`)
    window.history.pushState({}, '', target.pathname + target.search)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  if (error) return <main className="react-error"><h1>TechSMM</h1><p>{error}</p><a href="/">Return home</a></main>
  return <div className="mirrored-page" onClick={navigate} dangerouslySetInnerHTML={{ __html: html }} />
}

function App() {
  const [, refresh] = useState(0)
  useEffect(() => {
    const update = () => refresh((value) => value + 1)
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return <Page />
}

createRoot(document.getElementById('root')).render(<App />)
