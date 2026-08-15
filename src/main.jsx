import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const SITE_ROOT = new URL('site/techsmm.com/', window.location.href).pathname

function sourceForPath(pathname, search = '') {
  if (pathname === '/' || pathname === '') return 'index.html'
  let clean = pathname.replace(/^\/+/, '').replace(/^(?:Techsmm|techsmm\.com)\//i, '')
  clean = clean.replace(/^services\.html\//i, '')
  clean = clean.replace(/\.html\.html$/i, '.html')
  if (clean.toLowerCase() === 'blog/index.html') clean = 'blog.html'
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

function normalizeRoute(value) {
  if (!value || value.startsWith('#') || value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('javascript:')) return value
  let target
  try { target = new URL(value, window.location.href) } catch { return value }
  if (target.hostname !== window.location.hostname && !/^(www\.)?techsmm\.com$/i.test(target.hostname)) return value
  let path = target.pathname.replace(/^\/+(?:techsmm\.com\/)?/i, '/')
  path = path.replace(/^\/services\.html\//i, '/')
  path = path.replace(/\.html\.html$/i, '.html')
  if (path === '/index.html' || path === '/') return '/'
  if (path === '/blog/index.html' || path === '/blog.html') return '/blog'
  const blogPage = path.match(/^\/blog-page-(\d+)\.html$/i)
  if (blogPage) return `/blog?page=${blogPage[1]}`
  return path.replace(/\.html$/i, '') + target.search
}

function Page() {
  const [html, setHtml] = useState('')
  const [pendingHtml, setPendingHtml] = useState('')
  const [error, setError] = useState('')
  const [styles, setStyles] = useState([])
  const [title, setTitle] = useState('TechSMM')
  const [ready, setReady] = useState(false)
  const source = useMemo(() => sourceForPath(window.location.pathname, window.location.search), [window.location.pathname, window.location.search])

  useEffect(() => {
    let cancelled = false
    setError('')
    setHtml('')
    setPendingHtml('')
    setReady(false)
    fetch(`${SITE_ROOT}${source}`)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        return response.text()
      })
      .then((markup) => {
        if (cancelled) return
        const closingHtml = markup.search(/<\/html>/i)
        if (closingHtml !== -1) markup = markup.slice(0, closingHtml + 7)
        const document = new DOMParser().parseFromString(markup, 'text/html')
        setTitle(document.title || 'TechSMM')
        document.querySelectorAll('script').forEach((node) => node.remove())
        document.body.querySelectorAll('a[href]').forEach((node) => {
          const original = node.getAttribute('href')
          const normalized = normalizeRoute(original)
          if (normalized !== original) node.setAttribute('href', normalized)
        })
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
        setPendingHtml(document.body?.innerHTML || markup)
      })
      .catch((reason) => !cancelled && setError(`Page not found: ${source} (${reason.message})`))
    return () => { cancelled = true }
  }, [source])

  useEffect(() => {
    document.title = title
    const added = []
    const waitForStyles = []
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
        waitForStyles.push(new Promise((resolve) => {
          const timeout = window.setTimeout(resolve, 5000)
          node.onload = () => { window.clearTimeout(timeout); resolve() }
          node.onerror = () => { window.clearTimeout(timeout); resolve() }
        }))
        document.head.appendChild(node)
        added.push(node)
      }
    })
    if (!pendingHtml) return () => added.forEach((node) => node.remove())

    const imageUrls = [...new DOMParser()
      .parseFromString(pendingHtml, 'text/html')
      .querySelectorAll('img[src]')]
      .map((node) => node.getAttribute('src'))
      .filter(Boolean)
    const waitForImages = imageUrls.map((url) => new Promise((resolve) => {
      const image = new Image()
      const timeout = window.setTimeout(resolve, 5000)
      image.onload = () => { window.clearTimeout(timeout); resolve() }
      image.onerror = () => { window.clearTimeout(timeout); resolve() }
      image.src = url
    }))
    let active = true
    Promise.all([...waitForStyles, ...waitForImages]).then(() => {
      if (active) {
        setHtml(pendingHtml)
        setReady(true)
      }
    })
    return () => {
      active = false
      added.forEach((node) => node.remove())
    }
  }, [styles, title, pendingHtml])

  function navigate(event) {
    const anchor = event.target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || /^https?:\/\//i.test(href)) return
    event.preventDefault()
    const target = normalizeRoute(href)
    if (!target) return
    window.history.pushState({}, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  if (error) return <main className="react-error"><h1>TechSMM</h1><p>{error}</p><a href="/">Return home</a></main>
  if (!ready) return <main className="page-loading" aria-label="Loading page"><span>Loading…</span></main>
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
