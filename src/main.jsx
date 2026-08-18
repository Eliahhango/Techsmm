import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const SITE_ROOT = new URL('site/techsmm.com/', window.location.href).pathname

const PROTECTED_PATHS = [
  '/services',
  '/dashboard',
  '/account',
  '/addfunds',
  '/child-panel',
  '/massorder',
  '/orders',
  '/tickets',
  '/updates',
  '/api-dashboard',
  '/admin',
]

function requiresAuthentication(pathname) {
  const path = (pathname.replace(/\/+$/, '') || '/').replace(/\.html$/i, '')
  if (path === '/index') return true
  return PROTECTED_PATHS.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`))
}

function isAdminPath(pathname) {
  const path = (pathname.replace(/\/+$/, '') || '/').replace(/\.html$/i, '')
  return path === '/admin' || path.startsWith('/admin/')
}

async function apiFetch(input, options = {}) {
  const response = await fetch(input, options)
  if (response.status === 401) {
    localStorage.removeItem('token')
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }
  return response
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]))
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'
  } catch {
    return '#'
  }
}

function sourceForPath(pathname, search = '') {
  const isLoggedIn = !!localStorage.getItem('token')
  if (pathname === '/' || pathname === '') return isLoggedIn ? 'index.html' : 'landing.html'
  let clean = pathname.replace(/^\/+/, '').replace(/^(?:Techsmm|techsmm\.com)\//i, '')
  clean = clean.replace(/^services\.html\//i, '')
  clean = clean.replace(/\.html\.html$/i, '.html')
  if (clean.toLowerCase() === 'blog/index.html') clean = 'blog.html'
  if (clean === 'api' && isLoggedIn) return 'api-dashboard.html'
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
  if (value.startsWith('storage.') || value.startsWith('cdn.') || value.startsWith('cdnjs.') || value.startsWith('code.') || value.startsWith('unpkg.') || value.startsWith('oss.maxcdn.')) {
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
    const resp = await apiFetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
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
  const balanceText = `TSH ${Number(user.balance_tzs || 0).toLocaleString()}`
  doc.querySelectorAll('.balance, .user_balance .balance, .user_balance span').forEach((el) => {
    el.textContent = balanceText
  })

  // 3. Replace email in info cards
  doc.querySelectorAll('.user_info h4, .text_info h4').forEach((el) => {
    if (el.textContent.trim() === 'hangoeliah@gmail.com') el.textContent = user.email || ''
  })

  // 4. Replace user ID in info cards
  doc.querySelectorAll('.user_info h4, .text_info h4').forEach((el) => {
    if (el.textContent.trim() === '13792') el.textContent = String(user.id || '')
  })

  const accountFields = doc.querySelectorAll('#accountpage input[readonly]')
  if (accountFields[0]) accountFields[0].value = user.username
  if (accountFields[1]) accountFields[1].value = user.email || ''
  const currentEmail = doc.querySelector('#current-email')
  if (currentEmail) currentEmail.textContent = user.email || ''
  const language = doc.querySelector('#language')
  if (language && user.language) language.value = user.language
  const timezone = doc.querySelector('#timezone')
  if (timezone && user.timezone !== undefined) timezone.value = String(user.timezone)

  // 5. Replace fav_user_name in any remaining inline scripts
  doc.querySelectorAll('script').forEach((el) => {
    el.textContent = el.textContent.replace(/fav_user_name\s*=\s*"[^"]*"/, `fav_user_name = "${user.username}"`)
  })

  const replacements = [
    ['elitechwiz', user.username],
    ['hangoeliah@gmail.com', user.email || ''],
    ['13792', String(user.id || '')],
  ]
  const walker = doc.createTreeWalker(doc.body, 4)
  const textNodes = []
  while (walker.nextNode()) textNodes.push(walker.currentNode)
  textNodes.forEach((node) => {
    replacements.forEach(([from, to]) => {
      if (node.nodeValue.includes(from)) node.nodeValue = node.nodeValue.replaceAll(from, to)
    })
  })
  doc.querySelectorAll('input[value], textarea').forEach((field) => {
    replacements.forEach(([from, to]) => {
      if (field.value === from) field.value = to
      if (field.getAttribute('value') === from) field.setAttribute('value', to)
    })
  })
}

function replaceContactPhone(doc) {
  if (doc.body) {
    const currentYear = new Date().getFullYear()
    doc.body.innerHTML = doc.body.innerHTML
      .replaceAll('8801728744283', '255688164510')
      .replaceAll('8801708924551', '255688164510')
      .replaceAll('copyright 2023', `copyright ${currentYear}`)
  }
}

// ─── Replace USD prices with TZS in services table ────────
async function replacePricesWithTZS(doc) {
  try {
    const token = localStorage.getItem('token')
    if (!token) return
    const resp = await apiFetch('/api/services', { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.services) return

    // Build map: service_id → rate_tzs
    const priceMap = {}
    for (const s of data.services) {
      priceMap[s.service] = s.rate_tzs
    }

    // Replace $X.XX prices in table cells with TSH amounts
    doc.querySelectorAll('table tr').forEach((row) => {
      const idEl = row.querySelector('[data-filter-table-service-id], .order_id')
      if (!idEl) return
      const serviceId = idEl.textContent.trim() || idEl.getAttribute('data-filter-table-service-id')
      const tzsRate = priceMap[serviceId]
      if (!tzsRate) return

      // Find the <td> with dollar amount (rate per 1000)
      row.querySelectorAll('td').forEach((td) => {
        const text = td.textContent.trim()
        if (/^\$[\d.]+$/.test(text)) {
          td.textContent = `TSH ${tzsRate.toLocaleString()}`
        }
      })

      // Fix onclick handlers like showDetails(id,min,max,'$0.14')
      row.querySelectorAll('[onclick]').forEach((el) => {
        const onclick = el.getAttribute('onclick')
        if (onclick && onclick.includes('$')) {
          el.setAttribute('onclick', onclick.replace(/\$[\d.]+/g, `TSH ${tzsRate.toLocaleString()}`))
        }
      })
    })
  } catch { }
}

// ─── Dynamic Order Form: fetch services from API ──────────
function getCategoryIcon(cat) {
  const c = cat.toLowerCase()
  if (c.includes('tiktok')) return '<i class="fab fa-tiktok"></i>'
  if (c.includes('facebook')) return '<i class="fab fa-facebook"></i>'
  if (c.includes('instagram')) return '<i class="fab fa-instagram"></i>'
  if (c.includes('youtube')) return '<i class="fab fa-youtube"></i>'
  if (c.includes('whatsapp')) return '<i class="fab fa-whatsapp"></i>'
  if (c.includes('twitter') || c.includes('x ')) return '<i class="fab fa-twitter"></i>'
  if (c.includes('telegram')) return '<i class="fab fa-telegram"></i>'
  if (c.includes('linkedin')) return '<i class="fab fa-linkedin"></i>'
  if (c.includes('spotify')) return '<i class="fab fa-spotify"></i>'
  if (c.includes('snapchat')) return '<i class="fab fa-snapchat"></i>'
  if (c.includes('discord')) return '<i class="fab fa-discord"></i>'
  if (c.includes('reddit')) return '<i class="fab fa-reddit"></i>'
  if (c.includes('pinterest')) return '<i class="fab fa-pinterest"></i>'
  return '<i class="fas fa-globe"></i>'
}

function createCustomSelect(selectEl, items, onChange, renderItem) {
  const wrapper = selectEl.ownerDocument.createElement('div')
  wrapper.className = 'custom-select-wrapper'
  wrapper.style.cssText = 'position:relative;width:100%;'

  const trigger = selectEl.ownerDocument.createElement('div')
  trigger.className = 'custom-select-trigger'
  trigger.style.cssText = 'background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:10px 14px;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:14px;'

  const arrow = selectEl.ownerDocument.createElement('span')
  arrow.innerHTML = '<i class="fas fa-chevron-down"></i>'
  arrow.style.cssText = 'color:#999;font-size:12px;transition:transform 0.2s;'

  const panel = selectEl.ownerDocument.createElement('div')
  panel.className = 'custom-select-panel'
  panel.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;background:#1a1a2e;border:1px solid #333;border-radius:0 0 8px 8px;max-height:400px;overflow-y:auto;z-index:10000;box-shadow:0 8px 24px rgba(0,0,0,0.4);'

  const searchInput = selectEl.ownerDocument.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = 'Search...'
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 14px;background:#0f0f1e;border:none;border-bottom:1px solid #333;color:#fff;font-size:13px;outline:none;position:sticky;top:0;z-index:1;'

  panel.appendChild(searchInput)

  let selectedValue = items.length > 0 ? items[0].value : ''
  let selectedLabel = items.length > 0 ? items[0].label : 'Select...'

  function renderItems(filter = '') {
    const existingItems = panel.querySelectorAll('.custom-select-option')
    existingItems.forEach(el => el.remove())
    const lf = filter.toLowerCase()
    items.filter(item => !lf || item.label.toLowerCase().includes(lf)).forEach(item => {
      const opt = selectEl.ownerDocument.createElement('div')
      opt.className = 'custom-select-option'
      opt.style.cssText = 'padding:10px 14px;cursor:pointer;color:#ccc;font-size:13px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #222;transition:background 0.15s;'
      opt.innerHTML = renderItem ? renderItem(item) : `<span>${item.label}</span>`
      opt.dataset.value = item.value
      if (item.value === selectedValue) { opt.style.background = '#2a2a3e'; opt.style.color = '#fff' }
      opt.addEventListener('mouseenter', () => { opt.style.background = '#2a2a3e'; opt.style.color = '#fff' })
      opt.addEventListener('mouseleave', () => { if (item.value !== selectedValue) { opt.style.background = 'transparent'; opt.style.color = '#ccc' } })
      opt.addEventListener('click', () => {
        selectedValue = item.value
        selectedLabel = item.label
        selectEl.value = selectedValue
        trigger.querySelector('.trigger-label').innerHTML = renderItem ? renderItem(item) : `<span>${item.label}</span>`
        panel.style.display = 'none'
        arrow.querySelector('i').style.transform = 'rotate(0deg)'
        searchInput.value = ''
        if (onChange) onChange(item.value)
      })
      panel.appendChild(opt)
    })
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasOpen = panel.style.display === 'block'
    // Close all other custom selects
    selectEl.ownerDocument.querySelectorAll('.custom-select-panel').forEach(p => p.style.display = 'none')
    selectEl.ownerDocument.querySelectorAll('.custom-select-trigger .fa-chevron-down').forEach(a => a.style.transform = 'rotate(0deg)')
    if (!wasOpen) {
      panel.style.display = 'block'
      arrow.querySelector('i').style.transform = 'rotate(180deg)'
      searchInput.focus()
      renderItems()
    }
  })

  searchInput.addEventListener('input', () => renderItems(searchInput.value))
  searchInput.addEventListener('click', (e) => e.stopPropagation())

  selectEl.ownerDocument.addEventListener('click', () => {
    panel.style.display = 'none'
    arrow.querySelector('i').style.transform = 'rotate(0deg)'
  })

  trigger.appendChild(selectEl.ownerDocument.createElement('span'))
  trigger.querySelector('span:last-child').className = 'trigger-label'
  trigger.querySelector('span:last-child').style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
  trigger.querySelector('span:last-child').innerHTML = items.length > 0 ? (renderItem ? renderItem(items[0]) : `<span>${items[0].label}</span>`) : '<span>Select...</span>'
  trigger.appendChild(arrow)

  wrapper.appendChild(trigger)
  wrapper.appendChild(panel)
  selectEl.style.display = 'none'
  selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling)

  renderItems()
  return { setSelected: (val) => { selectedValue = val; selectEl.value = val; const item = items.find(i => i.value === val); if (item) { selectedLabel = item.label; trigger.querySelector('.trigger-label').innerHTML = renderItem ? renderItem(item) : `<span>${item.label}</span>`; if (onChange) onChange(val) } }, getValue: () => selectedValue }
}

async function setupDynamicOrderForm(doc) {
  try {
    const token = localStorage.getItem('token')
    if (!token) return
    const resp = await apiFetch('/api/services', { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.categories) return

    const categories = data.categories
    const catNames = Object.keys(categories)

    // Category items for custom dropdown
    const catItems = catNames.map(cat => ({ value: cat, label: cat, icon: getCategoryIcon(cat) }))

    const catSelect = doc.querySelector('#orderform-category')
    const serviceSelect = doc.querySelector('#orderform-service')

    function populateServices(category) {
      if (!serviceSelect) return
      const services = categories[category] || []
      const svcItems = services.map(s => ({
        value: String(s.service),
        label: `[${s.service}] ${s.name} - $${s.rate} per 1000`,
        service: s
      }))

      if (window._svcSelectCtrl) {
        // Remove old custom dropdown
        const oldWrapper = serviceSelect.parentNode.querySelector('.custom-select-wrapper')
        if (oldWrapper) oldWrapper.remove()
        window._svcSelectCtrl = null
      }

      window._svcSelectCtrl = createCustomSelect(serviceSelect, svcItems, (val) => {
        const svc = services.find(s => String(s.service) === val)
        if (svc) updateServiceDetails(svc, doc)
      }, (item) => {
        const s = item.service
        const refill = s.refill ? ' <span style="color:#4ade80;font-weight:600;">REFILL</span>' : ' <span style="color:#f87171;">NO REFILL</span>'
         return `<span style="background:#f97316;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${escapeHtml(s.service)}</span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}${refill} - $${escapeHtml(s.rate)} per 1000</span>`
      })

      if (services.length > 0) updateServiceDetails(services[0], doc)
    }

    function updateServiceDetails(svc, d) {
      const minMaxEl = d.querySelector('[data-id="serviceMinMax"]') || d.querySelector('.min_max')
      if (minMaxEl) minMaxEl.textContent = `Min: ${svc.min} - Max: ${svc.max.toLocaleString()}`
      const minMaxDisplay = d.querySelector('#min-max-display')
      if (minMaxDisplay) minMaxDisplay.textContent = `Min: ${svc.min} - Max: ${svc.max.toLocaleString()}`
      const priceEl = d.querySelector('[data-id="servicePrice"]') || d.querySelector('.service_price')
      if (priceEl) priceEl.textContent = `$${svc.rate} per 1000`
      const qtyInput = d.querySelector('#orderform-quantity')
      if (qtyInput) { qtyInput.min = svc.min; qtyInput.max = svc.max }
    }

    // Create custom category dropdown
    if (catSelect && catItems.length > 0) {
      window._catSelectCtrl = createCustomSelect(catSelect, catItems, (val) => {
        populateServices(val)
      }, (item) => {
        return `<span style="width:20px;text-align:center;">${item.icon}</span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.label)} <sup style="color:#4ade80;font-size:10px;">NEW</sup></span>`
      })
    }

    if (catNames.length > 0) populateServices(catNames[0])

    // Setup search box
    const searchInput = doc.querySelector('#template-input') || doc.querySelector('#new-order-search input')
    const searchDropdown = doc.querySelector('#new-order-search')
    if (searchInput && searchDropdown) {
      // Create results container
      let resultsDiv = searchDropdown.querySelector('.search-results')
      if (!resultsDiv) {
        resultsDiv = doc.createElement('div')
        resultsDiv.className = 'search-results'
        resultsDiv.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:#1a1a2e;border:1px solid #333;border-radius:8px;max-height:400px;overflow-y:auto;z-index:9999;display:none;'
        searchDropdown.appendChild(resultsDiv)
      }

      let debounceTimer
      searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer)
        const q = e.target.value.trim()
        if (q.length < 2) { resultsDiv.style.display = 'none'; return }
        debounceTimer = setTimeout(async () => {
          try {
            const sr = await apiFetch(`/api/services/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } })
            if (!sr.ok) return
            const sd = await sr.json()
            if (!sd.services || sd.services.length === 0) { resultsDiv.style.display = 'none'; return }
            resultsDiv.innerHTML = ''
            sd.services.forEach(s => {
              const item = doc.createElement('div')
              item.className = 'search-result-item'
              item.style.cssText = 'padding:10px 14px;cursor:pointer;border-bottom:1px solid #333;display:flex;align-items:center;gap:10px;color:#fff;font-size:13px;'
              item.innerHTML = `<span style="background:#f97316;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${escapeHtml(s.service)}</span> <span>${escapeHtml(s.name)} - $${escapeHtml(s.rate)} per 1000</span>`
              item.addEventListener('mouseenter', () => item.style.background = '#2a2a3e')
              item.addEventListener('mouseleave', () => item.style.background = 'transparent')
              item.addEventListener('click', () => {
                // Set category using custom select controller
                if (window._catSelectCtrl) {
                  window._catSelectCtrl.setSelected(s.category)
                }
                // Set service using custom select controller (after category change populates services)
                setTimeout(() => {
                  if (window._svcSelectCtrl) {
                    window._svcSelectCtrl.setSelected(String(s.service))
                  }
                }, 100)
                searchInput.value = s.name
                resultsDiv.style.display = 'none'
              })
              resultsDiv.appendChild(item)
            })
            resultsDiv.style.display = 'block'
          } catch { }
        }, 300)
      })

      // Close dropdown on outside click
      doc.addEventListener('click', (e) => {
        if (!searchDropdown.contains(e.target)) resultsDiv.style.display = 'none'
      })
    }
  } catch { }
}

// ─── Fetch deposits for logged-in user ─────────────────────
async function populateDeposits(doc) {
  try {
    const token = localStorage.getItem('token')
    if (!token) return
    const resp = await apiFetch('/api/deposits', { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.deposits) return

    const tbody = doc.querySelector('#addfundTable tbody')
    if (!tbody) return

    // Clear existing table body
    tbody.innerHTML = ''

    // Add actual deposits
    data.deposits.forEach((dep) => {
      const tr = doc.createElement('tr')
      const dateStr = new Date(dep.created_at).toLocaleString()
      tr.innerHTML = `
        <td><span class="tab_id">${dep.id}</span></td>
        <td><span class="tab_date">${dateStr}</span></td>
        <td><span class="tab_focus">${dep.method} (${dep.status})</span></td>
        <td><div class="tab_amount">${Number(dep.amount_tzs).toLocaleString()} TSH</div></td>
      `
      tbody.appendChild(tr)
    })
  } catch { }
}

// ─── Fetch orders and populate table ────────────────────────
async function populateOrders(doc, pathname) {
  try {
    const token = localStorage.getItem('token')
    if (!token) return

    // Trigger status update from live API in background
    await apiFetch('/api/orders/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }).catch(() => { })

    let statusFilter = ''
    if (pathname.endsWith('/pending')) statusFilter = 'Pending'
    else if (pathname.endsWith('/inprogress')) statusFilter = 'In progress'
    else if (pathname.endsWith('/completed')) statusFilter = 'Completed'
    else if (pathname.endsWith('/partial')) statusFilter = 'Partial'
    else if (pathname.endsWith('/processing')) statusFilter = 'Processing'
    else if (pathname.endsWith('/canceled')) statusFilter = 'Canceled'

    let url = '/api/orders'
    if (statusFilter) url += '?status=' + encodeURIComponent(statusFilter)

    const resp = await apiFetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.orders) return

    const tbody = doc.querySelector('#service-table tbody')
    if (!tbody) return

    tbody.innerHTML = ''

    if (data.orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center;">No orders found</td></tr>`
      return
    }

    data.orders.forEach((order) => {
      const tr = doc.createElement('tr')
      let badgeClass = 'badge bg-warning text-dark'
      if (order.status === 'Completed') badgeClass = 'badge bg-success'
      else if (order.status === 'Canceled') badgeClass = 'badge bg-danger'
      else if (order.status === 'Pending') badgeClass = 'badge bg-secondary'
      else if (order.status === 'In progress') badgeClass = 'badge bg-info text-dark'
      else if (order.status === 'Processing') badgeClass = 'badge bg-primary'

      const dateStr = new Date(order.created_at).toLocaleString()
      tr.innerHTML = `
        <td><span class="order_id">${escapeHtml(order.id)}</span></td>
        <td><span class="tab_date">${escapeHtml(dateStr)}</span></td>
        <td><a href="${escapeHtml(safeExternalUrl(order.link))}" target="_blank" rel="noopener noreferrer" style="word-break: break-all;">${escapeHtml(order.link)}</a></td>
        <td><span>TSH ${Number(order.charge_tzs).toLocaleString()}</span></td>
        <td><span>${escapeHtml(order.start_count || '0')}</span></td>
        <td><span>${escapeHtml(order.quantity)}</span></td>
        <td><span>Service #${escapeHtml(order.service_id)}</span></td>
        <td><span>${escapeHtml(order.remains || '0')}</span></td>
        <td><span class="${badgeClass}">${escapeHtml(order.status)}</span></td>
        <td>-</td>
      `
      tbody.appendChild(tr)
    })
  } catch { }
}

// ─── Calculate and replace dashboard stats ──────────────────
async function populateDashboardStats(doc) {
  try {
    const token = localStorage.getItem('token')
    if (!token) return
    const resp = await apiFetch('/api/orders', { headers: { Authorization: `Bearer ${token}` } })
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.orders) return

    const ordersCount = data.orders.length
    const totalSpend = data.orders.reduce((sum, order) => sum + (order.charge_tzs || 0), 0)

    doc.querySelectorAll('.user_info, .text_info').forEach((el) => {
      const titleEl = el.querySelector('h5')
      const valEl = el.querySelector('h4')
      if (titleEl && valEl) {
        const title = titleEl.textContent.trim().toLowerCase()
        if (title === 'my orders') {
          valEl.textContent = String(ordersCount)
        } else if (title === 'spend') {
          valEl.textContent = `TSH ${totalSpend.toLocaleString()}`
        }
      }
    })
  } catch { }
}

async function populateAdminPage(doc) {
  const token = localStorage.getItem('token')
  const headers = { Authorization: `Bearer ${token}` }
  const [usersResp, ordersResp, depositsResp, logsResp] = await Promise.all([
    apiFetch('/api/admin/users', { headers }),
    apiFetch('/api/admin/orders', { headers }),
    apiFetch('/api/admin/deposits', { headers }),
    apiFetch('/api/admin/audit-logs', { headers }),
  ])
  const responses = [usersResp, ordersResp, depositsResp, logsResp]
  if (responses.some((response) => !response.ok)) throw new Error('Unable to load admin data')
  const [users, orders, deposits, logs] = await Promise.all(responses.map((response) => response.json()))

  const userBody = doc.querySelector('#admin-users tbody')
  if (userBody) {
    userBody.innerHTML = users.users?.length
      ? users.users.map((user) => `<tr><td>${escapeHtml(user.id)}</td><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.email)}</td><td>TSH ${Number(user.balance_tzs || 0).toLocaleString()}</td><td>${escapeHtml(user.role)}</td></tr>`).join('')
      : '<tr><td colspan="5">No users found</td></tr>'
  }

  const orderBody = doc.querySelector('#admin-orders tbody')
  if (orderBody) {
    orderBody.innerHTML = orders.orders?.length
      ? orders.orders.map((order) => `<tr><td>${escapeHtml(order.id)}</td><td>${escapeHtml(order.username)}</td><td>${escapeHtml(order.service_id)}</td><td>${escapeHtml(order.status)}</td><td>TSH ${Number(order.charge_tzs || 0).toLocaleString()}</td></tr>`).join('')
      : '<tr><td colspan="5">No orders found</td></tr>'
  }

  const depositBody = doc.querySelector('#admin-deposits tbody')
  if (depositBody) {
    depositBody.innerHTML = deposits.deposits?.length
      ? deposits.deposits.map((deposit) => `<tr><td>${escapeHtml(deposit.id)}</td><td>${escapeHtml(deposit.username)}</td><td>TSH ${Number(deposit.amount_tzs || 0).toLocaleString()}</td><td>${escapeHtml(deposit.status)}</td><td>${deposit.status === 'Pending' ? `<button type="button" class="btn btn-primary btn-sm" data-admin-approve="${escapeHtml(deposit.id)}">Approve</button>` : '-'}</td></tr>`).join('')
      : '<tr><td colspan="5">No deposits found</td></tr>'
  }

  const logBody = doc.querySelector('#admin-logs tbody')
  if (logBody) {
    logBody.innerHTML = logs.logs?.length
      ? logs.logs.map((log) => `<tr><td>${escapeHtml(log.created_at)}</td><td>${escapeHtml(log.actor_username || 'System')}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.entity_type || '')} ${escapeHtml(log.entity_id || '')}</td></tr>`).join('')
      : '<tr><td colspan="4">No audit logs found</td></tr>'
  }
}

function Page() {
  const [html, setHtml] = useState('')
  const [pendingHtml, setPendingHtml] = useState('')
  const [error, setError] = useState('')
  const [styles, setStyles] = useState([])
  const [title, setTitle] = useState('TechSMM')
  const [ready, setReady] = useState(false)
  const [bodyClass, setBodyClass] = useState('dashboard')
  const activeStyleNodes = useRef([])
  const source = useMemo(() => sourceForPath(window.location.pathname, window.location.search), [window.location.pathname, window.location.search])

  useEffect(() => {
    let cancelled = false
    setError('')
    setPendingHtml('')
    setReady(false)

    if (requiresAuthentication(window.location.pathname) && !localStorage.getItem('token')) {
      window.history.replaceState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
      return () => { cancelled = true }
    }

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
        } catch { }
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
        replaceContactPhone(document)
        
        let extractedClass = document.body?.getAttribute('class') || 'dashboard'
        const isLoggedIn = !!localStorage.getItem('token')
        if (isLoggedIn) {
          extractedClass = extractedClass.replace(/\bnoAuth\b/g, '').trim() || 'dashboard'
          if (!extractedClass.includes('dashboard')) extractedClass += ' dashboard'
        }
        if (localStorage.getItem('techSMMCurrentMode') === 'night') {
          if (!extractedClass.includes('nightmode')) extractedClass += ' nightmode'
        }
        setBodyClass(extractedClass)
        document.body.className = extractedClass

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
        if (requiresAuthentication(window.location.pathname) && !user) {
          localStorage.removeItem('token')
          window.history.replaceState({}, '', '/')
          window.dispatchEvent(new PopStateEvent('popstate'))
          return
        }
        if (isAdminPath(window.location.pathname) && user.role !== 'admin') {
          window.history.replaceState({}, '', '/dashboard')
          window.dispatchEvent(new PopStateEvent('popstate'))
          return
        }
        if (user) replaceHardcodedData(document, user)

        const pathname = window.location.pathname

        const stylesheetUrls = [...document.querySelectorAll('link[rel="stylesheet"]')]
          .map((link) => localAsset(link.getAttribute('href')))
          .filter(Boolean)
        // Inject Bootstrap CSS if not already present (needed for grid/layout)
        const hasBootstrap = stylesheetUrls.some((u) => u.includes('bootstrap.min.css'))
        if (!hasBootstrap) {
          stylesheetUrls.unshift('/site/cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.3.7/css/bootstrap.min.css')
        }
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
    let committed = false
    Promise.all([...waitForStyles, ...waitForImages]).then(() => {
      if (active) {
        const previous = activeStyleNodes.current
        setHtml(pendingHtml)
        setReady(true)
        activeStyleNodes.current = added
        committed = true
        previous.forEach((node) => node.remove())
      }
    })
    return () => {
      active = false
      if (!committed) added.forEach((node) => node.remove())
    }
  }, [styles, title, pendingHtml])

  useEffect(() => () => {
    activeStyleNodes.current.forEach((node) => node.remove())
  }, [])

  function toggleTheme() {
    setBodyClass((prev) => {
      const isNight = prev.includes('nightmode')
      const next = isNight ? prev.replace(/\s*nightmode/, '').trim() : `${prev} nightmode`
      if (next.includes('nightmode')) {
        localStorage.setItem('techSMMCurrentMode', 'night')
      } else {
        localStorage.removeItem('techSMMCurrentMode')
      }
      document.body.classList.toggle('nightmode', next.includes('nightmode'))
      return next
    })
  }

  function navigate(event) {
    const anchor = event.target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || /^https?:\/\//i.test(href)) return
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

    let userHydrationActive = true
    fetchCurrentUser().then((user) => {
      if (userHydrationActive && user) replaceHardcodedData(document, user)
    })

    const pathname = window.location.pathname
    const hydrate = (task) => task.catch((error) => console.warn('Background page data load failed:', error.message))
    hydrate(replacePricesWithTZS(document))
    if (pathname === '/' || pathname === '') hydrate(setupDynamicOrderForm(document))
    if (pathname.includes('/addfunds')) hydrate(populateDeposits(document))
    if (pathname.startsWith('/orders')) hydrate(populateOrders(document, pathname))
    if (pathname.includes('/dashboard')) hydrate(populateDashboardStats(document))
    if (isAdminPath(pathname)) hydrate(populateAdminPage(document))

    // Global toggle helpers
    window.toggleSidebar = function () {
      const mainContainer = document.getElementById('main_container')
      if (mainContainer) mainContainer.classList.toggle('toogle_sidebar')
    }

    window.toggleThemeMode = function () {
      toggleTheme()
    }

    window.navToggleMob = function () {
      const mobileNav = document.getElementById('navMob')
      if (mobileNav) mobileNav.classList.toggle('active')
    }

    function closeAllOffcanvas() {
      document.querySelectorAll('.offcanvas.show').forEach((oc) => oc.classList.remove('show'))
    }

    function handlePageClick(e) {
      if (e.target.closest('.day_night_btn')) {
        e.preventDefault()
        e.stopPropagation()
        toggleTheme()
        return
      }
      if (e.target.closest('.sidebar_menu_icon, .close_btn_phone, .mob_bg_closer_sidebar')) {
        e.preventDefault()
        e.stopPropagation()
        window.toggleSidebar()
        return
      }
      const offcanvasBtn = e.target.closest('[data-bs-toggle="offcanvas"]')
      if (offcanvasBtn) {
        e.preventDefault()
        e.stopPropagation()
        const target = offcanvasBtn.getAttribute('data-bs-target')
        const offcanvas = target && document.querySelector(target)
        if (!offcanvas) return
        const isOpen = offcanvas.classList.contains('show')
        closeAllOffcanvas()
        if (!isOpen) {
          offcanvas.classList.add('show')
        }
        return
      }
      if (e.target.closest('.offcanvas .btn-close')) {
        e.preventDefault()
        closeAllOffcanvas()
        return
      }
      const approveButton = e.target.closest('[data-admin-approve]')
      if (approveButton) {
        e.preventDefault()
        e.stopPropagation()
        approveButton.disabled = true
        apiFetch(`/api/admin/deposit/${approveButton.dataset.adminApprove}/approve`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        })
          .then((response) => response.json())
          .then((data) => data.error ? alert(data.error) : populateAdminPage(document))
          .catch((error) => alert('Approval error: ' + error.message))
        return
      }
      const mobileNavLink = e.target.closest('#navMob a[href]')
      if (mobileNavLink) {
        document.getElementById('navMob')?.classList.remove('active')
        return
      }
      const menuLink = e.target.closest('.offcanvas .user_menu__item')
      if (menuLink) {
        e.preventDefault()
        e.stopPropagation()
        const href = menuLink.getAttribute('href')
        closeAllOffcanvas()
        if (href === '/logout') {
          localStorage.removeItem('token')
          window.history.pushState({}, '', '/')
          window.dispatchEvent(new PopStateEvent('popstate'))
        } else if (href) {
          window.history.pushState({}, '', href)
          window.dispatchEvent(new PopStateEvent('popstate'))
        }
        return
      }
    }
    page.addEventListener('click', handlePageClick, true)

    const showMoreBtn = document.getElementById('showMore')
    if (showMoreBtn) {
      showMoreBtn.onclick = function (e) {
        e.preventDefault()
        const moreMenu = document.getElementById('more_menu')
        if (moreMenu) moreMenu.classList.toggle('active_more_menu')
      }
    }

    page.querySelectorAll('[data-bs-toggle="pill"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = btn.getAttribute('data-bs-target')
        if (!target) return
        const tabContainer = btn.closest('.nav')
        if (tabContainer) {
          tabContainer.querySelectorAll('.nav-link').forEach(function (link) {
            link.classList.remove('active')
          })
        }
        btn.classList.add('active')
        const tabContent = btn.closest('.tab-content') || document.querySelector(target)?.closest('.tab-content')
        if (tabContent) {
          tabContent.querySelectorAll('.tab-pane').forEach(function (pane) {
            pane.classList.remove('show', 'active')
          })
        }
        const pane = document.querySelector(target)
        if (pane) pane.classList.add('show', 'active')
      })
    })

    page.querySelectorAll('[data-bs-toggle="collapse"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault()
        const target = btn.getAttribute('data-bs-target')
        if (!target) return
        const pane = document.querySelector(target)
        if (!pane) return
        const isOpen = pane.classList.contains('show')
        const parent = btn.closest('.accordion') || btn.closest('.accordion flush')
        if (parent) {
          parent.querySelectorAll('.accordion-collapse').forEach(function (c) {
            c.classList.remove('show')
          })
          parent.querySelectorAll('.accordion-button').forEach(function (b) {
            b.classList.add('collapsed')
            b.setAttribute('aria-expanded', 'false')
          })
        }
        if (!isOpen) {
          pane.classList.add('show')
          btn.classList.remove('collapsed')
          btn.setAttribute('aria-expanded', 'true')
        }
      })
    })

    // Intercept all form submissions — route to backend API
    function handleFormSubmit(e) {
      const form = e.target
      if (!form || form.tagName !== 'FORM') return
      e.preventDefault()
      e.stopPropagation()

      const action = (form.getAttribute('action') || '').toLowerCase()
      const fields = {}
      new FormData(form).forEach((val, key) => { fields[key] = val })
      const pathname = window.location.pathname

      // Signup form
      if (action.includes('signup') || fields['RegistrationForm[login]'] !== undefined) {
        const username = fields['RegistrationForm[login]'] || ''
        const email = fields['RegistrationForm[email]'] || ''
        const password = fields['RegistrationForm[password]'] || ''
        const password_confirmation = fields['RegistrationForm[password_again]'] || ''
        apiFetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password, password_confirmation }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.token) {
              localStorage.setItem('token', data.token)
              window.history.pushState({}, '', '/')
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
        apiFetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.token) {
              localStorage.setItem('token', data.token)
              window.history.pushState({}, '', '/')
              window.dispatchEvent(new PopStateEvent('popstate'))
            } else {
              alert(data.error || 'Login failed')
            }
          })
          .catch((err) => alert('Error: ' + err.message))
        return
      }

      // Add Funds form
      if (fields['AddFoundsForm[amount]'] !== undefined || pathname.includes('addfunds')) {
        const amount = Number(fields['AddFoundsForm[amount]'])
        const token = localStorage.getItem('token')
        if (!token) {
          alert('Not authenticated')
          return
        }
        apiFetch('/api/deposit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ amount })
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.error) {
              alert(data.error)
            } else {
              alert(`Deposit request #${data.deposit_id} submitted. It will be credited after payment confirmation.`)
              window.location.reload()
            }
          })
          .catch((err) => alert('Deposit error: ' + err.message))
        return
      }

      // Generate account API key
      if (action.includes('newkey')) {
        const token = localStorage.getItem('token')
        apiFetch('/api/account/api-key', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.error) return alert(data.error)
            const keyField = document.querySelector('#api_key')
            if (keyField) keyField.value = data.api_key
            alert('New API key generated. Store it securely.')
          })
          .catch((err) => alert('API key error: ' + err.message))
        return
      }

      // Revoke account API key
      if (action.includes('revoke') || action.includes('deletekey')) {
        const token = localStorage.getItem('token')
        apiFetch('/api/account/api-key', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + token },
        })
          .then((r) => r.json())
          .then((data) => data.error ? alert(data.error) : alert('API key revoked'))
          .catch((err) => alert('API key error: ' + err.message))
        return
      }

      // Save account language or timezone
      if (fields['SettingsFrom[lang]'] !== undefined || fields['SettingsFrom[timezone]'] !== undefined) {
        const token = localStorage.getItem('token')
        const language = fields['SettingsFrom[lang]'] || document.querySelector('#language')?.value || 'en'
        const timezone = Number(fields['SettingsFrom[timezone]'] || document.querySelector('#timezone')?.value || 10800)
        apiFetch('/api/account/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ language, timezone }),
        })
          .then((r) => r.json())
          .then((data) => data.error ? alert(data.error) : alert('Account preferences saved'))
          .catch((err) => alert('Preferences error: ' + err.message))
        return
      }

      // Change account password
      if (fields['SettingsFrom[current_password]'] !== undefined) {
        const token = localStorage.getItem('token')
        apiFetch('/api/account/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            current_password: fields['SettingsFrom[current_password]'],
            password: fields['SettingsFrom[password]'],
            confirm_password: fields['SettingsFrom[confirm_password]'],
          }),
        })
          .then((r) => r.json())
          .then((data) => data.error ? alert(data.error) : alert('Password changed successfully'))
          .catch((err) => alert('Password change error: ' + err.message))
        return
      }

      // Change account email
      if (fields['ChangeEmailForm[email]'] !== undefined) {
        const token = localStorage.getItem('token')
        apiFetch('/api/account/email', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            email: fields['ChangeEmailForm[email]'],
            password: fields['ChangeEmailForm[password]'],
          }),
        })
          .then((r) => r.json())
          .then((data) => data.error ? alert(data.error) : alert('Email changed successfully'))
          .catch((err) => alert('Email change error: ' + err.message))
        return
      }

      // New Order form
      if (fields['OrderForm[service]'] !== undefined || fields['service_id'] !== undefined || form.getAttribute('id') === 'order-form') {
        const service_id = fields['OrderForm[service]'] || fields['service_id']
        const link = fields['OrderForm[link]'] || fields['link']
        const quantity = Number(fields['OrderForm[quantity]'] || fields['quantity'])
        const token = localStorage.getItem('token')
        if (!token) {
          alert('Not authenticated')
          return
        }
        apiFetch('/api/order', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ service_id, link, quantity })
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.error) {
              alert(data.error)
            } else {
              alert(`Order placed successfully! Order ID: ${data.order_id}`)
              window.location.reload()
            }
          })
          .catch((err) => alert('Order placement error: ' + err.message))
        return
      }
    }

    page.addEventListener('submit', handleFormSubmit, true)
    return () => {
      userHydrationActive = false
      page.removeEventListener('submit', handleFormSubmit, true)
      page.removeEventListener('click', handlePageClick, true)
    }
  }, [ready, html])

  if (error && !html) return <main className="react-error"><h1>TechSMM</h1><p>{error}</p><a href="/">Return home</a></main>
  if (!html) return <main className="page-loading" aria-label="Loading page" />
  return <div id="body" aria-busy={!ready} className={`mirrored-page ${bodyClass}`} onClick={navigate} dangerouslySetInnerHTML={{ __html: html }} />
}

// Clean ugly URLs on load — redirect /techsmm.com/services.html/foo to /foo
function cleanUrl() {
  const p = window.location.pathname
  let cleaned = p.replace(/^\/techsmm\.com\/services\.html\//i, '/')
  cleaned = cleaned.replace(/^\/techsmm\.com\//i, '/')
  cleaned = cleaned.replace(/\.html$/i, '')
  if (cleaned !== p) {
    window.history.replaceState({}, '', cleaned + window.location.search)
  }
}

function App() {
  const [, refresh] = useState(0)
  useEffect(() => {
    if (!document.querySelector('script[data-techsmm-iconify]')) {
      const script = document.createElement('script')
      script.src = '/site/code.iconify.design/iconify-icon/1.0.7/iconify-icon.min.js'
      script.defer = true
      script.dataset.techsmmIconify = 'true'
      document.head.appendChild(script)
    }

    cleanUrl()
    const update = () => refresh((value) => value + 1)
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return <Page />
}

createRoot(document.getElementById('root')).render(<App />)
