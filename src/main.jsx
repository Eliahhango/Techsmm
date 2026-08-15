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
  if (clean.endsWith('.html')) return clean
  return `${clean}.html`
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

// ─── Fetch current user from backend ───────────────────────
async function fetchCurrentUser() {
  const token = localStorage.getItem('token')
  if (!token) return null
  try {
    const resp = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) return null
    const data = await resp.json()
    return data.user || null
  } catch { return null }
}

// ─── Replace hardcoded user data in HTML ───────────────────
function replaceHardcodedData(doc, user) {
  if (!user) return

  // 1. Replace username in sidebar h5 elements
  doc.querySelectorAll('.v2_user_info h5, .sidebar h5, .user_info h5').forEach((el) => {
    if (el.textContent.trim() === 'elitechwiz') el.textContent = user.username
  })

  // 2. Replace balance in sidebar balance span only
  doc.querySelectorAll('.balance, .user_balance .balance').forEach((el) => {
    const text = el.textContent.trim()
    if (text.startsWith('$') || text.startsWith('TSH')) {
      el.textContent = `TSH ${Number(user.balance_tzs || 0).toLocaleString()}`
    }
  })

  // 3. Replace email in info cards
  doc.querySelectorAll('.user_info h4, .text_info h4').forEach((el) => {
    if (el.textContent.trim() === 'hangoeliah@gmail.com') el.textContent = user.email || ''
  })

  // 4. Replace user ID in info cards
  doc.querySelectorAll('.user_info h4, .text_info h4').forEach((el) => {
    if (el.textContent.trim() === '13792') el.textContent = String(user.id || '')
  })

  // 5. Replace fav_user_name in any remaining inline scripts
  doc.querySelectorAll('script').forEach((el) => {
    el.textContent = el.textContent.replace(/fav_user_name\s*=\s*"[^"]*"/, `fav_user_name = "${user.username}"`)
  })
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

    const urls = [`${SITE_ROOT}${source}`]
    if (!source.endsWith('.html') || source.split('/').length > 1) {
      const dirPath = source.replace(/\.html$/, '')
      urls.push(`${SITE_ROOT}${dirPath}/index.html`)
    }

    async function tryFetch() {
      for (const url of urls) {
        try {
          const resp = await fetch(url)
          if (resp.ok) return await resp.text()
        } catch {}
      }
      throw new Error('Page not found')
    }

    tryFetch()
      .then(async (markup) => {
        if (cancelled) return
        const closingHtml = markup.search(/<\/html>/i)
        if (closingHtml !== -1) markup = markup.slice(0, closingHtml + 7)
        const document = new DOMParser().parseFromString(markup, 'text/html')
        setTitle(document.title || 'TechSMM')
        document.querySelectorAll('script').forEach((node) => node.remove())

        // Fix "Sign in" links on signup/index pages — they point to services.html but should go to /
        document.body.querySelectorAll('a[href]').forEach((node) => {
          const original = node.getAttribute('href')
          const label = node.textContent.trim().toLowerCase()
          const hrefNorm = original.replace(/^\/+(?:techsmm\.com\/)?/i, '/').replace(/\.html$/i, '')

          // "Sign in" on signup or index → go to / (login form is on index)
          if ((label === 'sign in' || label === 'log in') && (hrefNorm === '/services' || hrefNorm.includes('services'))) {
            node.setAttribute('href', '/')
            return
          }

          // "Sign up" on index → go to /signup
          if ((label === 'sign up' || label === 'register') && (hrefNorm.includes('signup') || hrefNorm.includes('register'))) {
            node.setAttribute('href', '/signup')
            return
          }

          const normalized = label === 'terms & conditions' || label === 'privacy policy'
            ? '/terms'
            : normalizeRoute(original)
          if (normalized !== original) node.setAttribute('href', normalized)
        })

        document.body.querySelectorAll('img[src],script[src],source[src],video[src],audio[src],iframe[src]').forEach((node) => {
          const original = node.getAttribute('src')
          const local = localAsset(original)
          if (local !== original) node.setAttribute('src', local)
        })

        // Replace hardcoded user data with actual logged-in user info
        const user = await fetchCurrentUser()
        if (user) replaceHardcodedData(document, user)

        const stylesheetUrls = [...document.querySelectorAll('link[rel="stylesheet"]')]
          .map((link) => localAsset(link.getAttribute('href')))
          .filter(Boolean)
        const inlineStyles = [...document.querySelectorAll('style')].map((style) => style.textContent)
        setStyles([...stylesheetUrls, ...inlineStyles.map((value) => `inline:${value}`)])
        setPendingHtml(document.body?.innerHTML || markup)
      })
      .catch((reason) => !cancelled && setError(`Page not found: ${source} (${reason.message || reason})`))
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

  // After HTML renders, intercept forms and inject auth bridge
  useEffect(() => {
    if (!ready) return
    const page = document.querySelector('.mirrored-page')
    if (!page) return

    // Intercept all form submissions — route to backend API
    function handleFormSubmit(e) {
      const form = e.target
      if (!form || form.tagName !== 'FORM') return
      e.preventDefault()
      e.stopPropagation()

      const action = (form.getAttribute('action') || '').toLowerCase()
      const fields = {}
      new FormData(form).forEach((val, key) => { fields[key] = val })

      // Signup form
      if (action.includes('signup') || fields['RegistrationForm[login]'] !== undefined) {
        const username = fields['RegistrationForm[login]'] || ''
        const email = fields['RegistrationForm[email]'] || ''
        const password = fields['RegistrationForm[password]'] || ''
        fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.token) {
              localStorage.setItem('token', data.token)
              window.history.pushState({}, '', '/dashboard')
              window.dispatchEvent(new PopStateEvent('popstate'))
            } else {
              alert(data.error || 'Registration failed')
            }
          })
          .catch((err) => alert('Error: ' + err.message))
        return
      }

      // Login form
      if (action.includes('login') || action.includes('services') || fields['LoginForm[username]'] !== undefined) {
        const email = fields['LoginForm[username]'] || ''
        const password = fields['LoginForm[password]'] || ''
        fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.token) {
              localStorage.setItem('token', data.token)
              window.history.pushState({}, '', '/dashboard')
              window.dispatchEvent(new PopStateEvent('popstate'))
            } else {
              alert(data.error || 'Login failed')
            }
          })
          .catch((err) => alert('Error: ' + err.message))
        return
      }
    }

    page.addEventListener('submit', handleFormSubmit, true)
    return () => page.removeEventListener('submit', handleFormSubmit, true)
  }, [ready, html])

  if (error) return <main className="react-error"><h1>TechSMM</h1><p>{error}</p><a href="/">Return home</a></main>
  if (!ready) return <main className="page-loading" aria-label="Loading page"><span>Loading…</span></main>
  return <div className="mirrored-page" onClick={navigate} dangerouslySetInnerHTML={{ __html: html }} />
}

// Clean ugly URLs on load — redirect /techsmm.com/services.html/foo to /foo
function cleanUrl() {
  const p = window.location.pathname
  // Strip /techsmm.com/services.html/ prefix
  let cleaned = p.replace(/^\/techsmm\.com\/services\.html\//i, '/')
  // Strip /techsmm.com/ prefix
  cleaned = cleaned.replace(/^\/techsmm\.com\//i, '/')
  // Strip trailing .html
  cleaned = cleaned.replace(/\.html$/i, '')
  if (cleaned !== p) {
    window.history.replaceState({}, '', cleaned + window.location.search)
  }
}

function App() {
  const [, refresh] = useState(0)
  useEffect(() => {
    cleanUrl()
    const update = () => refresh((value) => value + 1)
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return <Page />
}

createRoot(document.getElementById('root')).render(<App />)
