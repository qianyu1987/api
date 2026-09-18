(() => {
  const state = { registering: false, user: null, usageCursor: null, adminTab: 'overview', revealKeyId: null, walletAdjustUserId: null, overviewTimer: null, topupMultiplierBps: 30000, channelCostData: null, selectedCostChannel: null, selectedCostModel: null }
  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => [...document.querySelectorAll(selector)]
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
  const toMicros = (value) => {
    try { return BigInt(String(typeof value === 'object' && value !== null ? value.micros : value ?? 0)) } catch { return 0n }
  }
  const yuanToMicros = (value) => {
    const text = String(value ?? '').trim()
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error('金额格式无效')
    const parts = text.split('.')
    return BigInt(parts[0]) * 1000000n + BigInt((parts[1] || '').padEnd(6, '0'))
  }
  const microsToYuan = (value) => {
    const amount = toMicros(value)
    const negative = amount < 0n
    const absolute = negative ? -amount : amount
    const decimal = (absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
    return (negative ? '-' : '') + String(absolute / 1000000n) + (decimal ? '.' + decimal : '')
  }
  const money = (value) => {
    const amount = typeof value === 'object' && value !== null ? toMicros(value.micros) : yuanToMicros(value ?? 0)
    const negative = amount < 0n
    const cents = ((negative ? -amount : amount) + 5000n) / 10000n
    return (negative ? '-' : '') + '¥' + String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0')
  }
  const galleryAsset = (url) => url + (url.includes('?') ? '&' : '?') + 'v=1'
  const topupMultiplierLabel = () => {
    const bps = Number(state.topupMultiplierBps || 30000)
    const value = Number.isFinite(bps) && bps >= 10000 ? bps / 10000 : 3
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  }
  function applyTopupMultiplier(bps) {
    const parsed = Number(bps)
    if (Number.isInteger(parsed) && parsed >= 10000 && parsed <= 100000) state.topupMultiplierBps = parsed
    const ratio = topupMultiplierLabel()
    const title = $('#wallet-recharge-title'); if (title) title.textContent = '充值 1 元，到账 ' + ratio + ' 元'
    const mark = $('#wallet-recharge-ratio'); if (mark) mark.textContent = '1 : ' + ratio
    updateTopupCreditHint()
  }
  function updateTopupCreditHint() {
    const input = $('#topup-form [name="amount"]'); const hint = $('#topup-credit-hint'); if (!input || !hint) return
    try {
      const paid = yuanToMicros(input.value)
      const bps = BigInt(String(state.topupMultiplierBps || 30000))
      const credit = (paid * bps) / 10000n
      hint.textContent = '支付 ' + money({ micros: paid }) + '，钱包到账 ' + money({ micros: credit })
    } catch { hint.textContent = '支付金额将按当前充值倍率计入钱包' }
  }
  const integer = (value) => String(toMicros(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const margin = (cost, sell) => {
    const c = toMicros(cost); const s = toMicros(sell)
    return c > 0n && s >= c ? String(Number((10000n * (s - c)) / s) / 100) + '%' : '—'
  }
  const sellAt = (cost, bps) => {
    const amount = yuanToMicros(cost); const rate = BigInt(String(bps || 8000))
    if (amount <= 0n || rate < 0n || rate >= 10000n) return ''
    return microsToYuan((amount * 10000n + (10000n - rate) - 1n) / (10000n - rate))
  }
  function planProgressMarkup(balance, compact = false) {
    // New responses expose exact micro-yuan strings. Keep accepting the older
    // formatted yuan strings so a cached page or mixed-version API instance
    // cannot render a valid decimal balance as zero.
    const balanceAmount = (microsKey, yuanKey, fallback = 0n) => {
      if (balance?.[microsKey] !== undefined && balance?.[microsKey] !== null) return toMicros(balance[microsKey])
      const value = balance?.[yuanKey]
      if (value === undefined || value === null || value === '') return fallback
      try { return yuanToMicros(value) } catch { return fallback }
    }
    const quota = balanceAmount('planQuotaMicros', 'planQuota')
    const used = balanceAmount('planUsedMicros', 'planUsed')
    const reserved = balanceAmount('planReservedMicros', 'planReserved')
    const available = balanceAmount('planRemainingMicros', 'planRemaining')
    const book = balanceAmount('planBookRemainingMicros', 'planBookRemaining', available + reserved)
    const percent = quota > 0n ? Math.min(100, Math.max(0, Number((used * 10000n) / quota) / 100)) : 0
    const status = balance?.planStatus === 'active' ? (available <= 0n ? '套餐额度已用尽，请充值' : available * 100n <= quota * 20n ? '套餐可用额度偏低' : '套餐运行正常') : balance?.planStatus === 'expired' ? '套餐已过期，请续费' : '尚未开通套餐'
    if (quota <= 0n) return '<div class="plan-progress empty-progress"><div><strong>本周期套餐额度</strong><span>' + esc(status) + '</span></div></div>'
    return '<div class="plan-progress ' + (compact ? 'compact' : '') + '"><div class="progress-heading"><strong>本周期套餐额度</strong><span>' + percent.toFixed(1).replace('.0', '') + '% 已用</span></div><div class="progress-track"><i style="width:' + percent + '%"></i></div><div class="progress-meta"><span>已用 ' + money({ micros: used }) + '</span><span>可用 ' + money({ micros: available }) + '</span></div><div class="progress-submeta"><span>预扣 ' + money({ micros: reserved }) + ' · 账面剩余 ' + money({ micros: book }) + '</span><span class="' + (available * 100n <= quota * 20n ? 'warn' : 'muted') + '">' + esc(status) + '</span></div></div>'
  }

  function toast(message, error = false) {
    const node = $('#toast')
    node.textContent = message
    node.className = error ? 'show error' : 'show'
    setTimeout(() => { node.className = '' }, 2600)
  }
  async function api(url, options = {}) {
    const headers = new Headers(options.headers)
    if (options.body != null && options.body !== '' && !headers.has('Content-Type') && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await fetch(url, { credentials: 'include', ...options, headers })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || data.message || '请求失败（' + response.status + '）')
    return data
  }
  async function copyText(value) {
    if (!value) throw new Error('没有可复制的内容')
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) return await navigator.clipboard.writeText(value)
    } catch { /* use compatibility fallback */ }
    const input = document.createElement('textarea')
    input.value = value; input.readOnly = true; input.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(input); input.select()
    const copied = document.execCommand('copy')
    input.remove()
    if (!copied) throw new Error('复制失败，请手动复制')
  }
  async function copy(id) {
    try { await copyText(document.getElementById(id)?.textContent?.trim()); toast('已复制') } catch (error) { toast(error.message, true) }
  }
  function pending(button, active, label = '处理中…') {
    if (!button) return
    if (active) { button.dataset.label = button.textContent; button.textContent = label; button.disabled = true }
    else { button.textContent = button.dataset.label || button.textContent; button.disabled = false }
  }
  function applyBrand(site) {
    document.title = site?.title || 'GPT TOKEN | OpenAI 兼容 API 控制台'
    $$('[data-brand-name]').forEach((node) => { node.textContent = site?.name || 'GPT TOKEN' })
    $$('[data-brand-logo]').forEach((node) => { node.src = site?.logoUrl || '/assets/gpt-token-mark-192.png'; node.alt = site?.name || 'GPT TOKEN' })
  }
  let landingBase = 'https://api.hhtc.top/v1'
  let landingApi = 'responses'
  function renderLandingSnippet() {
    const chat = landingApi === 'chat'
    $('#landing-snippet').textContent = 'curl ' + landingBase + (chat ? '/chat/completions' : '/responses') + ' \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d ' + "'" + JSON.stringify(chat ? { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: '你好' }] } : { model: 'gpt-5.6-sol', input: '你好' }) + "'"
  }
  async function loadSite() {
    try {
      const site = await api('/api/public/site'); applyBrand(site)
      if (site.apiBaseUrl && /^https?:\/\//.test(site.apiBaseUrl)) landingBase = site.apiBaseUrl
      $('#landing-base').textContent = landingBase; $$('[data-landing-base]').forEach(node => { node.textContent = landingBase })
      const bps = Number(site.walletTopupMultiplierBps)
      $('#landing-offer').textContent = Number.isInteger(bps) && bps >= 10000 && bps <= 100000 ? '充值 1 元，到账 ' + (bps / 10000) + ' 元' : '充值优惠请登录查看'
    } catch { applyBrand(null); $('#landing-offer').textContent = '充值优惠请登录查看' }
    renderLandingSnippet()
  }
  function showPublicRoute() {
    const invite = new URLSearchParams(location.search).get('invite')?.trim()
    const hasInvite = Boolean(invite && /^[a-z0-9_-]{6,64}$/i.test(invite))
    const registering = location.pathname === '/register' || (hasInvite && location.pathname !== '/login')
    const auth = registering || location.pathname === '/login' || location.pathname === '/chat'
    $('#landing-view').classList.toggle('hidden', auth); $('#auth-view').classList.toggle('hidden', !auth)
    registerMode(registering); if (hasInvite) $('#auth-form [name="inviteCode"]').value = invite.toUpperCase()
  }
  $$('[data-landing-api]').forEach(button => button.addEventListener('click', () => {
    landingApi = button.dataset.landingApi; $$('[data-landing-api]').forEach(node => node.setAttribute('aria-pressed', String(node === button))); renderLandingSnippet()
  }))
  window.addEventListener('popstate', () => { if (!state.user) showPublicRoute(); else show(location.pathname === '/chat' ? 'chat' : 'overview') })

  function registerMode(enabled) {
    state.registering = enabled
    for (const id of ['email-field', 'invite-field', 'terms-field']) document.getElementById(id).classList.toggle('hidden', !enabled)
    $('#auth-title').textContent = enabled ? '创建账号' : '登录控制台'
    $('#auth-intro').textContent = enabled ? '填写账号和密码即可注册，邮箱为可选信息。' : '管理 API Key、额度、调用用量和接入配置。'
    $('#auth-submit').textContent = enabled ? '注册并登录' : '登录'
    $('#auth-toggle').textContent = enabled ? '已有账号？登录' : '没有账号？注册'
    $('#auth-form [name="email"]').required = false
    $('#auth-form [name="termsAccepted"]').required = enabled
    $('#auth-form [name="password"]').autocomplete = enabled ? 'new-password' : 'current-password'
    const password = $('#auth-form [name="password"]'); const toggle = $('#toggle-auth-password')
    password.type = 'password'; toggle.textContent = '显示'; toggle.setAttribute('aria-label', '显示密码'); toggle.setAttribute('aria-pressed', 'false')
    $('#auth-error').textContent = ''
  }
  function show(view) {
    $$('.view').forEach((node) => node.classList.toggle('active-view', node.id === 'view-' + view))
    $$('.nav-item').forEach((node) => { const active = node.dataset.view === view; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current') })
    const names = { chat:'免费智能', overview: '总览', recharge: '充值与套餐', keys: 'API Keys', media: '短剧创作', gallery: '素材广场', usage: '用量明细', affiliate: '邀请返利', downloads: '下载入口', admin: '管理后台' }
    $('#view-title').textContent = names[view] || '总览'
    $('.sidebar').classList.remove('open')
    if (view === 'chat') loadChat()
    if (view === 'overview') loadOverview()
    if (view === 'recharge') loadRecharge()
    if (view === 'media') loadMedia()
    if (view === 'gallery') loadGallery()
    if (view === 'keys') loadKeys()
    if (view === 'usage') { loadKeys(); loadUsage(true) }
    if (view === 'affiliate') loadAffiliate()
    if (view === 'downloads') loadDownloads()
    if (view === 'admin') loadAdmin(state.adminTab)
    if (state.overviewTimer) { clearInterval(state.overviewTimer); state.overviewTimer = null }
    if (view === 'overview' && !document.hidden) state.overviewTimer = setInterval(() => loadOverview(), 30000)
  }
  async function loadOverview() {
    try {
      const data = await api('/api/me/overview')
      applyTopupMultiplier(data.walletTopupMultiplierBps)
      state.user = data.user; $('#user-label').textContent = data.user.username
      const walletMicros = yuanToMicros(data.balance.wallet || '0')
      const planMicros = yuanToMicros(data.balance.planRemaining || '0')
      $('#balance-total').textContent = money({ micros: walletMicros + planMicros })
      $('#balance-detail').textContent = '钱包 ' + money(data.balance.wallet) + ' · 套餐 ' + money(data.balance.planRemaining)
      const discountPercent = Number(data.tokenDiscountPercent || 0)
      $('#token-discount').textContent = discountPercent > 0 ? discountPercent + '% off（实际支付 ' + (100 - discountPercent) + '%）' : '无折扣（原价）'
      $('#plan-expiry').textContent = data.balance.planExpiresAt ? new Date(data.balance.planExpiresAt).toLocaleDateString('zh-CN') : '未开通'
      const resetNode = $('#plan-reset')
      if (resetNode) resetNode.textContent = data.balance.planNextResetAt ? new Date(data.balance.planNextResetAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
      $('#api-base').textContent = data.apiBaseUrl; $('#account-state').textContent = data.balance.isValid ? '有效' : '需充值'
      const progress = $('#overview-plan-progress'); if (progress) progress.innerHTML = planProgressMarkup(data.balance)
      $('#chatgpt-link').href = data.downloads.chatgpt; $('#ccswitch-link').href = data.downloads.ccswitch
      $('#quick-config').textContent = 'Base URL: ' + data.apiBaseUrl + '\nAuthorization: Bearer sk-relay-…'
      const guideBase = $('#guide-api-base'); if (guideBase) guideBase.textContent = data.apiBaseUrl
      renderUsage('#recent-usage', (await api('/api/me/usage?limit=5')).items, true)
    } catch (error) { toast(error.message, true) }
  }
  async function loadKeys() {
    try {
      const data = await api('/api/me/keys')
      const select = $('#usage-key-filter')
      if (select) select.innerHTML = '<option value="">全部 Key</option>' + data.items.map((key) => '<option value="' + esc(key.id) + '">' + esc(key.name) + (key.revoked ? '（已撤销）' : '') + '</option>').join('')
      $('#keys-table').innerHTML = data.items.length ? data.items.map((key) => {
        const action = key.recoveryAvailable
          ? '<button type="button" class="small-button reveal-key" data-id="' + esc(key.id) + '">复制完整 Key</button><button type="button" class="small-button import-key" data-id="' + esc(key.id) + '">导入 CC Switch</button>'
          : '<span class="subline">旧 Key 无可恢复材料，请创建替代 Key</span><button type="button" class="small-button replace-key">创建替代 Key</button>'
        return '<tr><td>' + esc(key.name) + '</td><td><code>' + esc(key.prefix) + '…</code></td><td>' + date(key.createdAt) + '</td><td>' + (key.lastUsedAt ? date(key.lastUsedAt) : '从未') + '</td><td><span class="state ' + (key.revoked ? 'bad' : 'good') + '">' + (key.revoked ? '已撤销' : '启用') + '</span></td><td>' + (key.revoked ? '—' : '<div class="row-actions">' + action + '<button type="button" class="small-button danger-button revoke-key" data-id="' + esc(key.id) + '">撤销</button></div>') + '</td></tr>'
      }).join('') : '<tr><td colspan="6" class="empty">还没有 API Key，创建后即可调用模型</td></tr>'
    } catch (error) { toast(error.message, true) }
  }
  function openReveal(id) {
    state.revealKeyId = id; $('#key-reveal-password').value = ''; $('#key-reveal-value').textContent = ''; $('#key-reveal-error').textContent = ''
    $('#key-reveal-result').classList.add('hidden'); $('#key-password-field').classList.remove('hidden'); $('#key-reveal-actions').classList.remove('hidden')
    $('#key-reveal-description').textContent = '请验证当前密码后显示完整 Key。'; $('#key-reveal-dialog').showModal(); $('#key-reveal-password').focus()
  }
  async function importCcswitch(id, button) {
    pending(button, true, '正在打开…')
    try {
      const data = await api('/api/me/keys/' + encodeURIComponent(id) + '/ccswitch', { method: 'POST', body: '{}' })
      const link = data.importUrl || data.link
      if (!link?.startsWith('ccswitch://')) throw new Error('服务端未返回有效的导入链接')
      const copied = await copyText(link).then(() => true).catch(() => false)
      const anchor = document.createElement('a'); anchor.href = link; anchor.hidden = true; document.body.appendChild(anchor); anchor.click(); anchor.remove()
      toast(copied ? '正在打开 CC Switch，导入链接也已复制' : '正在打开 CC Switch')
    } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  }
  async function loadRecharge() {
    try {
      const [plans, overview] = await Promise.all([api('/api/plans'), api('/api/me/overview')])
      applyTopupMultiplier(overview.walletTopupMultiplierBps)
      const progress = $('#recharge-plan-progress'); if (progress) progress.innerHTML = planProgressMarkup(overview.balance)
      $('#plans').innerHTML = plans.items.length ? plans.items.map((plan) => '<div class="plan-option"><div><strong>' + esc(plan.name) + '</strong><small>30 天有效 · 每月 4 次额度 · 每次可消费额度 ' + money({ micros: plan.quota_micros }) + '</small><small class="plan-price">套餐价 ' + money({ micros: plan.price_micros }) + '</small></div><button class="button secondary buy-plan" type="button" data-id="' + esc(plan.id) + '" data-amount="' + esc(plan.price_micros) + '">购买套餐</button></div>').join('') : '<p class="empty">管理员尚未配置套餐</p>'
    } catch (error) { toast(error.message, true) }
  }
  function renderPayment(data) {
    const payment = data.payment || {}; const provider = '微信'; const raw = payment.qrCode || payment.codeUrl || ''
    const image = payment.qrImage || payment.qrDataUrl || data.qrImage || (String(raw).startsWith('data:image/') ? raw : '')
    const codeUrl = payment.codeUrl || (!String(raw).startsWith('data:image/') ? raw : '')
    $('#payment-result').classList.remove('hidden')
    const creditNote = data.walletCreditAmount ? '支付 ' + money(data.amount) + '，钱包到账 ' + money(data.walletCreditAmount) + '。' : ''
    $('#payment-result').innerHTML = '<div class="payment-layout">' + (image ? '<img class="payment-qr" src="' + esc(image) + '" alt="' + provider + '支付二维码">' : '') + '<div class="payment-details"><strong id="payment-status">订单已创建</strong><p id="payment-status-note">请使用' + provider + (image ? '扫描二维码' : '打开支付链接') + '完成支付。' + creditNote + '到账后余额会自动更新。</p>' + (codeUrl ? '<div class="copy-line"><code id="payment-code">' + esc(codeUrl) + '</code><button type="button" class="small-button" data-copy="payment-code">复制支付链接</button></div>' : '<p class="form-error">支付渠道未返回二维码，请稍后重试。</p>') + '</div></div>'
    if (data.orderId) {
      const started = Date.now(); const timer = setInterval(async () => {
        if (Date.now() - started > 31 * 60 * 1000) return clearInterval(timer)
        try { const order = await api('/api/me/orders/' + encodeURIComponent(data.orderId)); if (order.status === 'paid') { clearInterval(timer); $('#payment-status').textContent = '支付成功'; $('#payment-status-note').textContent = order.walletCreditAmount ? '钱包已到账 ' + money(order.walletCreditAmount) + '，正在刷新账户信息。' : '余额已入账，正在刷新账户信息。'; await Promise.all([loadOverview(), loadRecharge()]) } else if (['failed', 'expired', 'closed'].includes(order.status)) { clearInterval(timer); const labels = { failed: '失败', expired: '已过期', closed: '已关闭' }; $('#payment-status').textContent = '订单' + (labels[order.status] || order.status); $('#payment-status-note').textContent = '请重新创建订单或联系管理员处理。' } } catch { /* keep polling while the session is valid */ }
      }, 5000)
    }
  }
  async function loadUsage(reset) {
    try {
      if (reset) state.usageCursor = null
      const params = new URLSearchParams({ limit: '50' })
      for (const [key, value] of new FormData($('#usage-filters')).entries()) if (value) params.set(key, value)
      if (state.usageCursor) params.set('cursor', state.usageCursor)
      const data = await api('/api/me/usage?' + params)
      renderUsage('#usage-table', data.items, false, !reset); state.usageCursor = data.nextCursor; $('#usage-more').classList.toggle('hidden', !data.nextCursor)
      $('#usage-summary').innerHTML = '<span>请求 <strong>' + integer(data.summary.requests) + '</strong></span><span>收费 <strong>' + money(data.summary.charge) + '</strong></span><span>套餐扣费 <strong>' + money(data.summary.planCharge) + '</strong></span><span>钱包扣费 <strong>' + money(data.summary.walletCharge) + '</strong></span>'
      if (data.summary.profit) $('#usage-summary').insertAdjacentHTML('beforeend', '<span>成本 <strong>' + money(data.summary.estimatedCost) + '</strong></span><span>利润 <strong>' + money(data.summary.profit) + '</strong></span>')
    } catch (error) { toast(error.message, true) }
  }
  function renderUsage(selector, items, compact, append) {
    const body = $(selector)
    if (!items?.length) { if (!append) body.innerHTML = '<tr><td colspan="' + (compact ? 5 : 6) + '" class="empty">暂无用量记录</td></tr>'; return }
    const reason = (item) => item.success ? '' : '<small class="subline">' + esc(item.errorSummary || (item.statusCode === 403 ? '上游拒绝访问，可能是权限或余额不足' : item.statusCode >= 500 ? '上游服务暂时不可用' : '请求失败')) + ' · ' + esc(item.billingNote || '请求失败，未产生收费') + '</small>'
    const rows = items.map((item) => compact
      ? '<tr><td>' + date(item.time) + '</td><td>' + esc(item.model) + '</td><td>' + integer(item.totalTokens) + '</td><td>' + money(item.charge) + '</td><td><span class="state ' + (item.success ? 'good' : 'bad') + '">' + (item.success ? '成功' : '失败') + '</span>' + reason(item) + '</td></tr>'
      : '<tr><td>' + date(item.time) + '</td><td><code>' + esc(item.requestId).slice(0, 12) + '…</code></td><td><strong>' + esc(item.model) + '</strong><small class="subline">' + esc(item.channel || '—') + '</small></td><td>' + integer(item.totalTokens) + '<small class="subline">入 ' + integer(item.inputTokens) + ' / 出 ' + integer(item.outputTokens) + '</small></td><td>' + money(item.charge) + '<small class="subline">套餐 ' + money(item.planCharge) + ' · 钱包 ' + money(item.walletCharge) + '</small>' + (item.profit ? '<small class="subline">成本 ' + money(item.estimatedCost) + ' · 利润 ' + money(item.profit) + '</small>' : '') + '</td><td><span class="state ' + (item.success ? 'good' : 'bad') + '">' + (item.statusCode ?? '—') + ' · ' + (item.success ? '成功' : '失败') + '</span>' + reason(item) + '</td></tr>').join('')
    if (append) body.insertAdjacentHTML('beforeend', rows); else body.innerHTML = rows
  }
  async function loadAffiliate() {
    try {
      const data = await api('/api/me/affiliate'); $('#affiliate-balance').textContent = money({ micros: data.balanceMicros }); $('#affiliate-lifetime').textContent = money({ micros: data.lifetimeMicros }); $('#affiliate-converted').textContent = money({ micros: data.convertedMicros })
      $('#invite-code').textContent = data.inviteCode; $('#invite-link').textContent = location.origin + data.inviteLink; $('#invite-count').textContent = data.invitedCount; $('#affiliate-convert').disabled = toMicros(data.balanceMicros) <= 0n
      $('#affiliate-table').innerHTML = data.commissions?.length ? data.commissions.map((row) => '<tr><td>' + date(row.createdAt) + '</td><td>' + esc(row.invitedUsername) + '</td><td>' + money({ micros: row.paidAmountMicros }) + '</td><td>' + (Number(row.rateBps) / 100).toFixed(2).replace(/\.?0+$/, '') + '%</td><td class="amount-positive">+' + money({ micros: row.commissionMicros }) + '</td></tr>').join('') : '<tr><td colspan="5" class="empty">还没有返利记录</td></tr>'
      const labels = { commission_credit: '返利入账', commission: '返利入账', conversion_debit: '兑换到钱包', convert: '兑换到钱包', admin_adjustment: '人工调整', reversal: '返利冲正' }
      $('#affiliate-ledger').innerHTML = data.ledger?.length ? data.ledger.map((row) => '<tr><td>' + date(row.createdAt) + '</td><td>' + (labels[row.kind] || esc(row.kind)) + '</td><td class="' + (toMicros(row.amountMicros) >= 0n ? 'amount-positive' : 'amount-negative') + '">' + (toMicros(row.amountMicros) > 0n ? '+' : '') + money({ micros: row.amountMicros }) + '</td><td>' + money({ micros: row.balanceAfterMicros }) + '</td></tr>').join('') : '<tr><td colspan="4" class="empty">暂无资金记录</td></tr>'
    } catch (error) { toast(error.message, true) }
  }
  async function loadDownloads() { try { const data = await api('/api/downloads'); $('#chatgpt-link').href = data.chatgpt; $('#ccswitch-link').href = data.ccswitch; const guideLink = $('#ccswitch-guide-download'); if (guideLink) guideLink.href = data.ccswitch; const guideBase = $('#guide-api-base'); if (guideBase && data.apiBaseUrl) guideBase.textContent = data.apiBaseUrl } catch (error) { toast(error.message, true) } }

  const field = (name, label, value = '', type = 'text', extra = '') => '<label>' + label + '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '" ' + extra + '></label>'
  const check = (name, label, checked = true) => '<label class="checkbox-label"><input name="' + name + '" type="checkbox" ' + (checked ? 'checked' : '') + '>' + label + '</label>'
  const form = (kind, fields, submit = '保存') => '<form class="admin-form" data-admin-form="' + kind + '">' + fields.join('') + '<div class="form-actions"><button class="button primary" type="submit">' + submit + '</button></div></form>'
  const table = (headings, rows, empty = '暂无数据') => rows.length ? '<div class="table-wrap scroll-table"><table><thead><tr>' + headings.map((heading) => '<th>' + esc(heading) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' : '<div class="table-wrap"><p class="empty">' + empty + '</p></div>'
  const rate = (row, name) => row[name + '_micros_per_million'] ?? row[name + '_micros'] ?? '0'

  function renderAdmin(tab, data) {
    const items = data.items || []
    if (tab === 'overview') {
      const m = data.metrics || {}; const mv = (v) => v?.yuan || '0'
      return '<div class="summary-strip"><span>请求 <strong>' + integer(m.requests) + '</strong></span><span>收入 <strong>' + mv(m.revenue) + '</strong></span><span>模型成本 <strong>' + mv(m.cost) + '</strong></span><span>毛利 <strong>' + mv(m.grossProfit) + '</strong></span><span>返利 <strong>' + mv(m.rebates) + '</strong></span><span>净利润 <strong>' + mv(m.netProfit) + '</strong></span></div><div class="notice">最低毛利线：' + ((data.minimumMarginBps || 3000) / 100) + '% · 未处理告警：' + (data.alerts || []).length + '</div>' + ((data.alerts || []).length ? '<div class="notice"><ul>' + data.alerts.map(alert => '<li>' + esc(alert.message) + '</li>').join('') + '</ul></div>' : '') + (m.pendingCostRequests ? '<p class="admin-note">本期 ' + integer(m.pendingCostRequests) + ' 笔兜底请求尚无经核实的渠道成本，以上成本和利润包含估算。</p>' : '') + table(['渠道', '请求', '失败', '状态'], (data.channels || []).map((c) => '<tr><td>' + esc(c.name) + '</td><td>' + integer(c.requests) + '</td><td>' + integer(c.failures) + '</td><td>' + (c.circuit_open_until && new Date(c.circuit_open_until).getTime() > Date.now() ? '<span class="state bad">熔断</span>' : '<span class="state good">正常</span>') + '</td></tr>'), '暂无渠道数据')
    }
    if (tab === 'media-admin') {
      const prices = data.prices || []; const channels = data.channels || []
      const mediaRows=(data.tasks||[]).map(t=>'<tr><td><div class="admin-media-preview">'+(t.result_url?(t.kind==='video'?'<video src="/api/admin/media/tasks/'+esc(t.id)+'/result" muted preload="metadata"></video>':'<img src="/api/admin/media/tasks/'+esc(t.id)+'/result" alt="作品预览" loading="lazy">'):'<span>无结果</span>')+'</div></td><td>'+esc(t.username)+'<small class="subline">'+date(t.created_at)+'</small></td><td>'+(t.kind==='video'?'视频':'图片')+'<small class="subline">'+esc(t.status)+'</small></td><td><input class="gallery-title-input" data-gallery-title="'+esc(t.id)+'" maxlength="80" value="'+esc(t.gallery_title||'')+'" placeholder="公开标题"></td><td><span class="state '+(t.gallery_status==='published'?'good':'bad')+'">'+({published:'已发布',hidden:'已隐藏',private:'未发布'}[t.gallery_status]||'未发布')+'</span>'+(t.gallery_featured?'<small class="subline">精选作品</small>':'')+'</td><td><div class="row-actions">'+(t.status==='completed'?'<button class="small-button" type="button" data-gallery-action="publish" data-featured="'+String(t.gallery_featured===true)+'" data-id="'+esc(t.id)+'">发布</button><button class="small-button" type="button" data-gallery-action="feature" data-featured="'+String(t.gallery_featured===true)+'" data-id="'+esc(t.id)+'">'+(t.gallery_featured?'取消精选':'设为精选')+'</button><button class="small-button" type="button" data-gallery-action="hide" data-id="'+esc(t.id)+'">隐藏</button><button class="small-button danger-button" type="button" data-gallery-action="private" data-id="'+esc(t.id)+'">移出广场</button>':'—')+(t.status==='unknown'?'<button type="button" class="small-button" data-media-resolve="'+esc(t.id)+'">核实处理</button>':'')+'</div></td></tr>')
      return '<p class="notice">目标利润率 30%，已考虑充值倍率、支付费用和返利。常规成本决定售价，实际成本单独记录。金额单位：人民币元 / 张；视频为元 / 秒。成本未核实请勿启用。</p>' + prices.map(p => form('media-price', [
        field('model','模型',p.model,'text','readonly'),field('size','规格',p.size,'text','readonly'),
        '<label>媒体专用渠道<select name="channelId" required>' + channels.map(c=>'<option value="'+esc(c.id)+'" '+(c.id===p.channel_id?'selected':'')+'>'+esc(c.name)+'</option>').join('') + '</select></label>',
        field('normalCostYuan','常规人民币成本',microsToYuan(p.normal_cost_micros)),field('actualCostYuan','当前实际人民币成本',microsToYuan(p.actual_cost_micros)),field('costSource','核实来源与日期',p.cost_source,'text','required'),check('enabled','开放此规格',p.enabled)
      ],'保存媒体价格')).join('') + '<div class="section-heading compact-heading"><div><h4>作品管理</h4><p class="muted">新作品默认不公开。发布前可填写标题，精选作品优先展示；移出广场不会删除账单和生成记录。</p></div></div>' + table(['预览','用户 / 时间','类型 / 状态','广场标题','公开状态','操作'],mediaRows,'暂无媒体作品')
    }
    if (tab === 'channels') {
      const editor = form('channel', [field('name', '渠道名称', '', 'text', 'required'), field('baseUrl', '上游地址', '', 'url', 'required'), field('apiKey', '上游 Key', '', 'password', 'required'), field('priority', '优先级', '100', 'number', 'min="0"'), field('timeoutMs', '超时毫秒', '30000', 'number', 'min="1000" max="120000"'), field('modelMap', '模型映射 JSON', '{}'), check('enabled', '启用')], '新增渠道')
      const balance = item => { const b=item.upstreamBalance||{}; if(b.status==='available')return '<div class="upstream-balance'+(Number(b.remaining)<0?' unavailable':'')+'"><strong>'+esc((b.unit||'¥')+' '+Number(b.remaining).toLocaleString('zh-CN',{maximumFractionDigits:8}))+'</strong>'+(b.quota!=null?'<small>总额 '+esc(Number(b.quota).toLocaleString('zh-CN',{maximumFractionDigits:8}))+'</small>':'')+(b.message?'<small>'+esc(b.message)+'</small>':'')+'<small>'+date(b.checkedAt)+' 查询</small></div>';return '<div class="upstream-balance unavailable"><strong>'+esc(b.status==='error'?'查询失败':'不可查询')+'</strong><small>'+esc(b.message||'供应商未提供余额接口')+'</small><small>'+date(b.checkedAt)+' 检查</small></div>' }
      const rows = items.map((item) => '<tr><td><strong>' + esc(item.name) + '</strong><small class="subline">' + esc(item.baseUrl) + '</small></td><td>' + balance(item) + '</td><td>' + item.priority + '</td><td>' + item.timeoutMs + ' ms</td><td><code class="inline-code">' + esc(JSON.stringify(item.modelMap || {})) + '</code></td><td><span class="state ' + (item.enabled ? 'good' : 'bad') + '">' + (item.enabled ? '启用' : '停用') + '</span>' + (item.fallbackCostPending ? '<small class="subline">兜底成本待核实</small>' : '') + '</td><td class="admin-action-cell"><div class="row-actions channel-actions"><button class="small-button admin-edit" type="button" data-kind="channel" data-item="' + esc(JSON.stringify(item)) + '">编辑</button><button class="small-button" type="button" data-channel-cost="' + esc(item.id) + '">成本</button><button class="small-button" type="button" data-channel-action="disable" data-id="' + esc(item.id) + '" data-name="' + esc(item.name) + '" ' + (item.enabled ? '' : 'disabled') + '>停用</button><button class="small-button danger-button" type="button" data-channel-action="archive" data-id="' + esc(item.id) + '" data-name="' + esc(item.name) + '">删除</button></div></td></tr>')
      return editor + '<div class="admin-toolbar"><p>余额每 60 秒自动更新；点击可立即重新查询上游。</p><button class="button secondary" type="button" data-refresh-channel-balances>刷新上游余额</button></div>' + table(['渠道', '上游余额', '优先级', '超时', '模型映射', '状态', '操作'], rows, '尚未添加上游渠道')
    }
    if (tab === 'channel-costs') {
      state.channelCostData = data
      const options = (data.channels || []).map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.enabled ? '' : '（停用）') + '</option>').join('')
      const editor = form('channel-cost', [
        '<label>渠道<select name="channelId" required>' + options + '</select></label>',
        '<label>用户调用的模型<select name="modelPattern" required></select></label>',
        '<p id="channel-cost-target" class="admin-note wide"></p>',
        ...['input', 'output', 'cache'].map((part, i) => field(part + 'CostYuanPerMillion', ['输入', '输出', '缓存'][i] + '实际成本（元 / 百万 Token）', '', 'text', 'inputmode="decimal" required')),
        field('highContextIncreasePercent', '超过 272K 的成本涨幅（%）', '20', 'number', 'min="0" max="1000" step="0.01" required'),
        field('priceSource', '成本来源（账单日期或供应商报价）', '', 'text', 'maxlength="512" required'),
        '<p class="admin-note wide">填写已包含账户折扣的人民币实际成本，不再乘汇率。缓存免费时明确填 0。保存后立即用于新请求，已有账单及用户售价保持原快照。</p>',
        '<p id="channel-cost-preview" class="admin-note wide" aria-live="polite"></p><p id="channel-cost-error" class="form-error wide" role="alert"></p>',
      ], '保存渠道成本')
      const amount = row => row ? ['input', 'output', 'cache'].map(part => microsToYuan(row[part + '_cost_micros_per_million'])).join(' / ') : '未配置'
      const rows = items.map(item => '<tr><td>' + esc(item.channel_name) + '</td><td>' + esc(item.model_pattern) + '</td><td>' + esc(amount(item)) + '</td><td>' + (Number(item.high_context_multiplier_bps) / 10000) + ' 倍</td><td>' + esc(item.price_source || '未填写') + '</td><td>' + date(item.price_effective_at) + '</td></tr>')
      const audits = (data.audits || []).map(item => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.actor_name || '系统') + '</td><td>' + esc((data.channels || []).find(c => c.id === item.after_value?.channel_id)?.name || item.after_value?.channel_id || '—') + '<small class="subline">' + esc(item.after_value?.model_pattern) + '</small></td><td>' + esc(amount(item.before_value)) + '</td><td>' + esc(amount(item.after_value)) + '</td><td>' + esc(item.after_value?.price_source || '—') + '</td></tr>')
      return editor + '<p class="admin-section-title">当前成本 · 输入 / 输出 / 缓存（元 / 百万 Token）</p>' + table(['渠道', '公开模型', '标准成本', '272K+ 倍率', '来源', '生效时间'], rows, '尚未配置渠道成本') + '<p class="admin-section-title">最近 50 次修改</p>' + table(['时间', '修改人', '渠道 / 模型', '修改前', '修改后', '来源'], audits, '暂无成本修改记录')
    }
    if (tab === 'prices') {
      const inputs = ['input', 'output', 'cache'].flatMap((name) => [field(name + 'CostYuanPerMillion', (name === 'input' ? '输入' : name === 'output' ? '输出' : '缓存') + '成本（元/百万 Token）', '0', 'text', 'data-price-cost="' + name + '"'), field(name + 'SellYuanPerMillion', (name === 'input' ? '输入' : name === 'output' ? '输出' : '缓存') + '售价（元/百万 Token）', '0')])
      const editor = form('price', [field('modelPattern', '模型匹配', '*', 'text', 'required'), field('marginBps', '目标毛利率（基点）', '8000', 'number', 'min="0" max="9999" data-margin'), field('tierIncreasePercent', '272K+ 涨价比例（%）', '20', 'number', 'min="0" max="1000"'), ...inputs, check('active', '启用'), '<p class="admin-note wide">缓存按普通输入价计费；输入 Token 超过 272K 后自动使用涨价层。售价按目标毛利率自动计算；数据库仍以微元/百万 Token 保存。</p>'], '保存模型价格')
      const rows = items.map((item) => { const tiers = Array.isArray(item.pricing_tiers) ? item.pricing_tiers : []; const high = tiers.find((tier) => Number(tier.thresholdTokens) > 0); return '<tr><td><strong>' + esc(item.model_pattern) + '</strong><small class="subline">' + esc(item.price_source || '手工设置') + '</small></td><td>' + money({ micros: rate(item, 'input_sell') }) + (high ? '<small class="subline">272K+ ' + money({ micros: high.inputSellMicrosPerMillion }) + '</small>' : '') + '<small class="subline">成本 ' + money({ micros: rate(item, 'input_cost') }) + ' · ' + margin(rate(item, 'input_cost'), rate(item, 'input_sell')) + '</small></td><td>' + money({ micros: rate(item, 'output_sell') }) + (high ? '<small class="subline">272K+ ' + money({ micros: high.outputSellMicrosPerMillion }) + '</small>' : '') + '<small class="subline">成本 ' + money({ micros: rate(item, 'output_cost') }) + ' · ' + margin(rate(item, 'output_cost'), rate(item, 'output_sell')) + '</small></td><td>' + money({ micros: rate(item, 'cache_sell') }) + '</td><td><span class="state ' + (item.active ? 'good' : 'bad') + '">' + (item.active ? '启用' : '停用') + '</span></td><td class="admin-action-cell"><button class="small-button admin-edit" type="button" data-kind="price" data-item="' + esc(JSON.stringify(item)) + '">编辑</button><button class="small-button danger-button admin-delete" type="button" data-kind="price" data-id="' + esc(item.id) + '">停用</button></td></tr>' })
      return '<div class="admin-toolbar"><p>只会初始化已启用渠道实际映射的模型；上游页面标注为美元的数值按人民币 1:1 结算，不再乘以 7.2。</p><button class="button secondary" type="button" data-bootstrap="openai-prices">按上游 1:1 价格初始化</button></div>' + editor + table(['模型 / 来源', '输入售价', '输出售价', '缓存售价', '状态', '操作'], rows, '尚未配置模型价格')
    }
    if (tab === 'fixed-prices') {
      const method = '<label>方法<select name="httpMethod"><option>ANY</option><option>GET</option><option selected>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label>'
      const mode = '<label>计费单位<select name="unitMode"><option value="request">每请求</option><option value="count">按数量</option><option value="seconds">按秒数</option></select></label>'
      const editor = form('fixed-price', [method, field('pathPattern', '接口路径', '/v1/images/generations', 'text', 'required'), field('requestedModel', '限定模型（可选）'), field('selectors', '规格筛选 JSON（可选）', '{}'), mode, field('unitPath', '数量/秒数字段（可选）', '', 'text', 'placeholder="n 或 duration"'), field('costYuan', '成本（元 / 计费单位）', '0', 'text', 'data-fixed-cost required'), field('marginBps', '目标毛利率（基点）', '8000', 'number', 'min="0" max="9999" data-fixed-margin'), field('sellYuan', '自动售价（元 / 计费单位）', '0', 'text', 'data-fixed-sell readonly'), field('matchPriority', '匹配优先级', '100', 'number', 'min="0"'), check('enabled', '启用'), '<p class="admin-note wide">规格筛选未命中时网关会拒绝请求，避免免费或亏损调用。</p>'], '保存固定接口价格')
      const rows = items.map((item) => '<tr><td>' + esc(item.http_method) + '</td><td><code>' + esc(item.path_pattern) + '</code><small class="subline">' + esc(JSON.stringify(item.selectors || {})) + '</small></td><td>' + esc(item.requested_model || '全部') + '</td><td>' + esc(item.unit_mode || 'request') + (item.unit_path ? ' · ' + esc(item.unit_path) : '') + '</td><td>' + money({ micros: item.sell_micros }) + '<small class="subline">成本 ' + money({ micros: item.cost_micros }) + ' · ' + margin(item.cost_micros, item.sell_micros) + '</small></td><td><span class="state ' + (item.enabled ? 'good' : 'bad') + '">' + (item.enabled ? '启用' : '停用') + '</span></td><td class="admin-action-cell"><button class="small-button admin-edit" type="button" data-kind="fixed-price" data-item="' + esc(JSON.stringify(item)) + '">编辑</button><button class="small-button danger-button admin-delete" type="button" data-kind="fixed-price" data-id="' + esc(item.id) + '">停用</button></td></tr>')
      return editor + table(['方法', '路径 / 规格', '模型', '单位', '售价', '状态', '操作'], rows, '尚未配置固定接口价格')
    }
    if (tab === 'plans') {
      const editor = form('plan', [field('code', '套餐代码', 'monthly-149', 'text', 'required'), field('name', '套餐名称', '月套餐', 'text', 'required'), field('priceYuan', '售价（元）', '149.00', 'text', 'required'), field('quotaYuan', '周期额度（元）', '149.00', 'text', 'required'), field('displayOrder', '排序', '10', 'number', 'min="0"'), check('active', '可购买'), '<p class="admin-note wide">套餐有效期 30 天；每周一 09:00（北京时间）恢复周期额度至上限，未用额度不结转。</p>'], '保存套餐')
      const rows = items.map((item) => '<tr><td><strong>' + esc(item.name) + '</strong><small class="subline">' + esc(item.code) + '</small></td><td>' + money({ micros: item.price_micros }) + '</td><td>' + money({ micros: item.quota_micros }) + '</td><td>周期重置</td><td>30 天</td><td><span class="state ' + (item.active && item.enabled ? 'good' : 'bad') + '">' + (item.active && item.enabled ? '启用' : '停用') + '</span></td><td class="admin-action-cell"><button class="small-button admin-edit" type="button" data-kind="plan" data-item="' + esc(JSON.stringify(item)) + '">编辑</button><button class="small-button danger-button admin-delete" type="button" data-kind="plan" data-id="' + esc(item.id) + '">停用</button></td></tr>')
      return '<div class="admin-toolbar"><p>独立购买、支付入账和套餐优先扣费均已启用。</p><button class="button secondary" type="button" data-bootstrap="monthly-plan">初始化 ¥149 月套餐</button></div>' + editor + table(['套餐', '售价', '可消费额度', '毛利率', '有效期', '状态', '操作'], rows, '尚未配置套餐')
    }
    if (tab === 'users-discount') tab = 'users'
    if (tab === 'users') {
      return table(['用户', '钱包 / 可用', 'Token 折扣', '本周期额度', '到期 / 重置', '状态', '操作'], items.map((item) => {
        const discount = Number(item.token_discount_bps || 0) / 100
        const wallet = toMicros(item.balance_micros); const walletReserved = toMicros(item.wallet_reserved_micros)
        const planQuota = toMicros(item.plan_quota_micros); const planBook = toMicros(item.plan_remaining_micros); const planReserved = toMicros(item.plan_reserved_micros); const planAvailable = planBook > planReserved ? planBook - planReserved : 0n; const planUsed = planQuota > planBook ? planQuota - planBook : 0n
        return '<tr><td><strong>' + esc(item.username) + '</strong><small class="subline">' + esc(item.email || '未验证邮箱') + '</small></td><td>' + money({ micros: wallet }) + '<small class="subline">可用 ' + money({ micros: wallet - walletReserved }) + ' · 预扣 ' + money({ micros: walletReserved }) + '</small></td><td><form class="inline-discount" data-user-id="' + esc(item.id) + '"><div class="discount-input"><input name="discount" type="number" min="0" max="99" step="1" value="' + esc(discount) + '" aria-label="' + esc(item.username) + ' 折扣减免比例"><span>%</span></div><button class="small-button" type="submit">保存</button><small class="subline">实际支付 ' + (100 - discount) + '%</small></form></td><td>' + (item.plan_status === 'active' ? planProgressMarkup({ planQuotaMicros: planQuota, planUsedMicros: planUsed, planReservedMicros: planReserved, planBookRemainingMicros: planBook, planRemainingMicros: planAvailable, planStatus: item.plan_status }, true) : '—') + '</td><td>' + (item.plan_status === 'active' ? date(item.plan_expires_at) + '<small class="subline">下次 ' + date(item.plan_next_reset_at) + '</small>' : '—') + '</td><td><span class="state ' + (item.status === 'active' ? 'good' : 'bad') + '">' + esc(item.status) + '</span></td><td><div class="admin-user-actions"><button class="small-button wallet-adjust" type="button" data-id="' + esc(item.id) + '" data-username="' + esc(item.username) + '">充值/扣费</button>' + (item.plan_status === 'active' ? '<button class="small-button admin-reset-plan" type="button" data-id="' + esc(item.id) + '">重置额度</button>' : '') + '</div></td></tr>'
      }))
    }
    if (tab === 'affiliate-admin') {
      const settings = Object.fromEntries((data.settings || []).map((item) => [item.key, item.value]))
      const editor = form('affiliate-settings', [field('rateBps', '返利比例（基点，1000 = 10%）', settings.affiliate_rate_bps || '1000', 'number', 'min="0" max="10000"'), check('enabled', '开启返利', settings.affiliate_enabled !== 'false')], '保存返利设置')
      const commission = (data.commissions || []).map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.inviter_username) + '</td><td>' + esc(item.invitee_username) + '</td><td>' + money({ micros: item.paid_amount_micros }) + '</td><td>' + (Number(item.rate_bps) / 100).toFixed(2) + '%</td><td>' + money({ micros: item.commission_micros }) + '</td></tr>')
      const conversion = (data.conversions || []).map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td>' + money({ micros: item.amount_micros }) + '</td><td>已完成</td></tr>')
      return editor + '<div><p class="admin-section-title">佣金流水</p>' + table(['时间', '邀请人', '被邀请人', '充值', '比例', '返利'], commission, '暂无佣金流水') + '</div><div><p class="admin-section-title">兑换流水</p>' + table(['时间', '用户', '兑换金额', '状态'], conversion, '暂无兑换流水') + '</div>'
    }
    if (tab === 'orders') return table(['时间', '用户', '类型', '金额', '方式', '状态', '订单号'], items.map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td>' + esc(item.kind) + '</td><td>' + money({ micros: item.amount_micros }) + '</td><td>' + esc(item.payment_method) + '</td><td><span class="state ' + (item.status === 'paid' ? 'good' : 'bad') + '">' + esc(item.status) + '</span></td><td><code>' + esc(item.order_no) + '</code></td></tr>'))
    if (tab === 'admin-usage') {
      const rows = items.map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td><code>' + esc(item.request_id) + '</code></td><td>' + esc(item.requested_model) + (item.upstream_model && item.upstream_model !== item.requested_model ? '<small class="subline">上游 ' + esc(item.upstream_model) + '</small>' : '') + '</td><td>' + esc(item.final_channel_name_snapshot || '—') + '</td><td>' + money({ micros: item.charge_micros }) + '</td><td>' + money({ micros: item.cost_micros }) + ' / ' + money({ micros: item.profit_micros }) + (item.fallbackCostPending ? '<small class="subline">兜底成本待核实 · 利润为估算</small>' : '') + '</td><td><button class="small-button admin-attempts" type="button" data-id="' + esc(item.request_id) + '">链路</button></td></tr>')
      return table(['时间', '用户', '请求 ID', '模型', '最终渠道', '收费', '成本 / 利润', '操作'], rows) + '<div id="attempt-detail"></div>'
    }
    if (tab === 'resets') {
      const rows = items.map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td>' + esc(item.reset_kind) + '</td><td>' + esc(item.actor_username || '系统') + '</td><td>' + money({ micros: item.before_remaining_micros }) + '</td><td>' + money({ micros: item.after_remaining_micros }) + '</td><td><code>' + esc(item.reset_key) + '</code></td></tr>')
      return table(['时间', '用户', '类型', '执行者', '重置前', '重置后', '周期标识'], rows, '暂无套餐重置记录')
    }
    if (tab === 'settings') {
      const settings = Object.fromEntries(items.map((item) => [item.key, item.value])); const smtp = data.mail || {}; const profit = data.profit || {}
      const siteEditor = form('site-settings', [field('name', '站点名称', settings.site_name || 'GPT TOKEN', 'text', 'required'), field('title', '浏览器标题', settings.site_title || 'GPT TOKEN | OpenAI 兼容 API 控制台', 'text', 'required'), field('logoUrl', 'Logo 地址', settings.site_logo_url || '/assets/gpt-token-mark-192.png', 'text', 'required'), '<p class="admin-note wide">Logo 已本地托管。SMTP 密码、上游 Key 和用户 API Key 不会出现在本页面、数据库或日志。</p>'], '保存站点设置')
      const profitEditor = form('profit-settings', [field('minimumMarginBps', '最低毛利率（基点，3000 = 30%）', String(profit.minimumMarginBps ?? settings.profit_min_margin_bps ?? 3000), 'number', 'min="0" max="9999" required'), field('paymentFeeRateBps', '支付手续费率（基点）', String(profit.paymentFeeRateBps ?? settings.payment_fee_rate_bps ?? 0), 'number', 'min="0" max="10000" required'), field('globalDiscountBps', '全局减免比例（基点，1000 = 10%）', String(profit.globalDiscountBps ?? settings.global_token_discount_bps ?? 0), 'number', 'min="0" max="9900" required'), '<div class="admin-note wide">当前安全上限：<strong>' + ((Number(profit.maxDiscountBps || 0)) / 100) + '%</strong>。折扣、支付手续费和返利合计后必须达到最低毛利线；超过 272K 的价格层也会参与校验。</div>'], '保存利润设置')
      const blockers = (profit.blockers || []).slice(0, 6).map((item) => '<li>' + esc(item.model + ' · ' + item.tier + ' · ' + item.part + '：' + (item.reason || '低于安全上限')) + '</li>').join('')
      return '<div class="settings-status"><div><span class="label">邮件服务</span><strong>' + (smtp.configured ? '已配置' : '未配置') + '</strong></div><div><span class="label">SMTP 主机</span><strong>' + esc(smtp.host || '—') + '</strong></div><div><span class="label">发件地址</span><strong>' + esc(smtp.from || '—') + '</strong></div><div><span class="label">TLS</span><strong>' + (smtp.secure ? '已启用' : '未启用') + '</strong></div></div>' + profitEditor + (blockers ? '<div class="notice"><strong>风险配置</strong><ul>' + blockers + '</ul></div>' : '') + siteEditor
    }
    return table([], [])
  }
  async function loadAdmin(tab) {
    if (!document.querySelector('[data-admin-tab="overview"]')) {
      const first = document.querySelector('.admin-tabs .tab');
      if (first) first.insertAdjacentHTML('beforebegin', '<button class="tab" type="button" data-admin-tab="overview">经营概览</button>')
    }
    state.adminTab = tab
    $$('.admin-tabs .tab').forEach((node) => node.classList.toggle('active', node.dataset.adminTab === tab))
    const endpoints = { 'media-admin': '/api/admin/media', overview: '/api/admin/overview', channels: '/api/admin/channels', 'channel-costs': '/api/admin/channel-costs', prices: '/api/admin/prices', 'fixed-prices': '/api/admin/fixed-prices', plans: '/api/admin/plans', users: '/api/admin/users', orders: '/api/admin/orders', 'admin-usage': '/api/admin/usage', resets: '/api/admin/subscription-resets', 'affiliate-admin': '/api/admin/affiliate', settings: '/api/admin/settings' }
    try { $('#admin-content').innerHTML = renderAdmin(tab, await api(endpoints[tab])); if (tab === 'channel-costs') { const editor = $('[data-admin-form="channel-cost"]'); if (state.selectedCostChannel && (state.channelCostData.channels || []).some(c => c.id === state.selectedCostChannel)) setFormValue(editor, 'channelId', state.selectedCostChannel); refreshChannelCostEditor(true) } } catch (error) { toast(error.message, true) }
  }

  let galleryKind = ''
  async function loadGallery() {
    $('#gallery-grid').innerHTML='<p class="empty">正在加载作品…</p>';$('#gallery-error').textContent=''
    try {
      const data=await api('/api/gallery'+(galleryKind?'?kind='+encodeURIComponent(galleryKind):''))
      $('#gallery-grid').innerHTML=data.items.length?data.items.map(item=>'<article class="gallery-item">'+(item.kind==='video'?'<video controls preload="metadata" src="'+esc(galleryAsset(item.assetUrl))+'" aria-label="'+esc(item.title)+'"></video>':'<a href="'+esc(galleryAsset(item.assetUrl))+'" target="_blank" rel="noopener"><img src="'+esc(galleryAsset(item.assetUrl))+'" alt="'+esc(item.title)+'" loading="lazy"></a>')+'<div class="gallery-caption"><strong>'+esc(item.title)+'</strong><span>'+(item.featured?'精选 · ':'')+(item.kind==='video'?'视频作品':'图片作品')+'</span></div>'+(state.user?.role==='admin'?'<div class="gallery-admin-actions"><button class="small-button danger-button" type="button" data-gallery-delete="'+esc(item.id)+'" data-title="'+esc(item.title)+'" aria-label="从广场删除'+esc(item.title)+'">删除作品</button></div>':'')+'</article>').join(''):'<div class="gallery-empty"><strong>广场正在准备作品</strong><p>管理员发布精选作品后会显示在这里。</p><button class="button primary" type="button" data-go="media">去创作</button></div>'
      $('#gallery-grid [data-go="media"]')?.addEventListener('click',()=>show('media'))
    } catch(error){$('#gallery-grid').innerHTML='';$('#gallery-error').textContent=error.message+'，请稍后刷新。'}
  }
  function setFormValue(editor, name, value) {
    const node = editor.elements.namedItem(name); if (!node) return
    if (node.type === 'checkbox') node.checked = Boolean(value); else node.value = value ?? ''
  }
  function editAdmin(kind, item) {
    const editor = $('[data-admin-form="' + kind + '"]'); if (!editor) return
    let id = editor.elements.namedItem('id')
    if (!id) { id = document.createElement('input'); id.type = 'hidden'; id.name = 'id'; editor.appendChild(id) }
    id.value = item.id
    if (kind === 'channel') {
      Object.entries({ name: item.name, baseUrl: item.baseUrl, priority: item.priority, timeoutMs: item.timeoutMs, modelMap: JSON.stringify(item.modelMap || {}), enabled: item.enabled }).forEach(([key, value]) => setFormValue(editor, key, value))
      setFormValue(editor, 'apiKey', ''); editor.elements.namedItem('apiKey').required = false; editor.elements.namedItem('apiKey').placeholder = '留空则保持原上游 Key'
      editor.querySelector('[type="submit"]').textContent = '保存修改'
      let cancel = editor.querySelector('[data-cancel-channel-edit]')
      if (!cancel) { cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button'; cancel.dataset.cancelChannelEdit = ''; cancel.textContent = '取消编辑'; editor.querySelector('.form-actions').prepend(cancel) }
    }
    if (kind === 'price') {
      setFormValue(editor, 'modelPattern', item.model_pattern)
      for (const part of ['input', 'output', 'cache']) { setFormValue(editor, part + 'CostYuanPerMillion', microsToYuan(rate(item, part + '_cost'))); setFormValue(editor, part + 'SellYuanPerMillion', microsToYuan(rate(item, part + '_sell'))) }
      const high = Array.isArray(item.pricing_tiers) ? item.pricing_tiers.find((tier) => Number(tier.thresholdTokens) > 0) : null
      if (high) { const base = BigInt(String(rate(item, 'input_cost')) || '0'); const highCost = BigInt(String(high.inputCostMicrosPerMillion || '0')); setFormValue(editor, 'tierIncreasePercent', base > 0n ? Number((highCost * 10000n / base) - 10000n) / 100 : 20) }
      setFormValue(editor, 'active', item.active)
    }
    if (kind === 'fixed-price') {
      Object.entries({ httpMethod: item.http_method, pathPattern: item.path_pattern, requestedModel: item.requested_model, selectors: JSON.stringify(item.selectors || {}), unitMode: item.unit_mode || 'request', unitPath: item.unit_path || '', costYuan: microsToYuan(item.cost_micros), sellYuan: microsToYuan(item.sell_micros), matchPriority: item.match_priority, enabled: item.enabled }).forEach(([key, value]) => setFormValue(editor, key, value))
      editor.dataset.manualSell = 'true'
    }
    if (kind === 'plan') Object.entries({ code: item.code, name: item.name, priceYuan: microsToYuan(item.price_micros), quotaYuan: microsToYuan(item.quota_micros), displayOrder: item.display_order, active: item.active && item.enabled }).forEach(([key, value]) => setFormValue(editor, key, value))
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  function refreshChannelCostEditor(changeChannel) {
    const editor = $('[data-admin-form="channel-cost"]'); if (!editor) return
    const data = state.channelCostData || {}; const channel = (data.channels || []).find(c => c.id === editor.elements.channelId.value)
    state.selectedCostChannel = channel?.id || null
    if (changeChannel) {
      const models = [...new Set([...Object.keys(channel?.model_map || {}).filter(m => m !== '*'), ...(data.items || []).filter(c => c.channel_id === channel?.id).map(c => c.model_pattern), '*'])]
      editor.elements.modelPattern.innerHTML = models.map(model => '<option value="' + esc(model) + '">' + esc(model === '*' ? '默认（所有已映射模型）' : model) + '</option>').join('')
      if (models.includes(state.selectedCostModel)) setFormValue(editor, 'modelPattern', state.selectedCostModel)
    }
    const model = editor.elements.modelPattern.value; state.selectedCostModel = model
    const row = (data.items || []).find(c => c.channel_id === channel?.id && c.model_pattern === model)
    for (const part of ['input', 'output', 'cache']) setFormValue(editor, part + 'CostYuanPerMillion', row ? microsToYuan(row[part + '_cost_micros_per_million']) : '')
    setFormValue(editor, 'priceSource', row?.price_source || '')
    setFormValue(editor, 'highContextIncreasePercent', row ? (Number(row.high_context_multiplier_bps) - 10000) / 100 : 20)
    editor.dataset.expectedUpdatedAt = row?.updated_at || ''
    const upstream = channel?.model_map?.[model] || channel?.model_map?.['*']
    $('#channel-cost-target').textContent = (upstream ? '实际上游模型：' + upstream + '。' : '默认成本适用于未单独配置成本的映射模型。') + (row ? '当前生效时间：' + date(row.price_effective_at) : '当前未配置专属成本，请按供应商账单填写。')
    $('#channel-cost-error').textContent = ''; previewChannelCost(editor)
  }
  function previewChannelCost(editor) {
    const target = $('#channel-cost-preview'); if (!target) return
    try {
      const increase = Number(editor.elements.highContextIncreasePercent.value)
      if (!Number.isFinite(increase) || increase < 0 || increase > 1000) throw new Error('invalid')
      const multiplier = BigInt(Math.round(10000 + increase * 100))
      const values = ['input', 'output', 'cache'].map(part => microsToYuan((yuanToMicros(editor.elements[part + 'CostYuanPerMillion'].value) * multiplier + 9999n) / 10000n))
      target.textContent = '272K+ 成本预览（输入 / 输出 / 缓存）：' + values.join(' / ') + ' 元 / 百万 Token。'
    } catch { target.textContent = '请填写三个成本金额后查看 272K+ 成本预览。' }
  }
  function calculateToken(editor) {
    const bps = editor.elements.namedItem('marginBps')?.value || '8000'
    for (const part of ['input', 'output', 'cache']) { const cost = editor.elements.namedItem(part + 'CostYuanPerMillion'); const sell = editor.elements.namedItem(part + 'SellYuanPerMillion'); if (cost && sell) { try { sell.value = sellAt(cost.value, bps) } catch { sell.value = '' } } }
  }
  function calculateFixed(editor) {
    try { editor.elements.namedItem('sellYuan').value = sellAt(editor.elements.namedItem('costYuan').value, editor.elements.namedItem('marginBps').value) } catch { editor.elements.namedItem('sellYuan').value = '' }
  }
  async function submitAdmin(editor) {
    const kind = editor.dataset.adminForm; const payload = Object.fromEntries(new FormData(editor).entries())
    for (const checkbox of editor.querySelectorAll('input[type="checkbox"]')) payload[checkbox.name] = checkbox.checked
    if (kind === 'channel') { try { payload.modelMap = JSON.parse(payload.modelMap || '{}') } catch { throw new Error('模型映射必须是合法 JSON') } }
    if (kind === 'fixed-price' && editor.dataset.manualSell !== 'true') delete payload.sellYuan
    const endpoints = { 'media-price': '/api/admin/media/prices', channel: '/api/admin/channels', 'channel-cost': '/api/admin/channel-costs', price: '/api/admin/prices', 'fixed-price': '/api/admin/fixed-prices', plan: '/api/admin/plans', 'affiliate-settings': '/api/admin/affiliate/settings', 'site-settings': '/api/admin/settings/site', 'profit-settings': '/api/admin/settings/profit' }
    const method = kind === 'affiliate-settings' || kind === 'profit-settings' ? 'PATCH' : kind === 'site-settings' ? 'PUT' : 'POST'
    if (kind === 'channel-cost') {
      payload.highContextMultiplierBps = Math.round(10000 + Number(payload.highContextIncreasePercent) * 100)
      payload.expectedUpdatedAt = editor.dataset.expectedUpdatedAt || null
      $('#channel-cost-error').textContent = ''
      if (!confirm('确认保存该渠道的实际人民币成本？新请求立即使用，历史账单不变。')) return
    }
    const button = editor.querySelector('[type="submit"]'); if (button.disabled) return
    const cancel = editor.querySelector('[data-cancel-channel-edit]'); if (cancel) cancel.disabled = true
    pending(button, true, '保存中…')
    try { await api(endpoints[kind], { method, body: JSON.stringify(payload) }); toast(kind === 'channel' ? (payload.id ? '渠道修改已保存' : '渠道已新增') : '已保存'); if (kind === 'site-settings') await loadSite(); await loadAdmin(kind === 'affiliate-settings' ? 'affiliate-admin' : state.adminTab) } catch (error) { if (kind === 'channel-cost') $('#channel-cost-error').textContent = error.message; throw error } finally { pending(button, false); if (cancel) cancel.disabled = false }
  }
  async function deleteAdmin(kind, id, button) {
    const endpoint = { channel: '/api/admin/channels/' + encodeURIComponent(id), price: '/api/admin/prices/' + encodeURIComponent(id), 'fixed-price': '/api/admin/fixed-prices/' + encodeURIComponent(id), plan: '/api/admin/plans/' + encodeURIComponent(id) }[kind]
    if (!confirm('确定停用这条配置？历史记录不会删除。')) return
    pending(button, true, '停用中…'); try { await api(endpoint, { method: 'DELETE' }); toast('已停用'); await loadAdmin(state.adminTab) } finally { pending(button, false) }
  }
  let channelAction = null
  function openChannelAction(button) {
    const archive = button.dataset.channelAction === 'archive'
    const label = archive ? '删除' : '停用'
    channelAction = { id: button.dataset.id, archive }
    $('#channel-action-title').textContent = label + '渠道'
    $('#channel-action-description').textContent = '确定' + label + '「' + button.dataset.name + '」？' + (archive ? '删除后将从渠道列表移除，无法直接重新启用。' : '停用后保留在列表中，可通过编辑重新启用。') + '该渠道将不再接收新请求；正在处理的请求继续结算，历史用量、成本和账单保留。请确认其他渠道足以承接请求。'
    $('#channel-action-error').textContent = ''
    $('#channel-action-submit').textContent = '确认' + label
    $('#channel-action-dialog').showModal()
    $('#channel-action-cancel').focus()
  }
  async function loadAttempts(requestId) {
    const host = $('#attempt-detail'); if (!host) return; host.innerHTML = '<p class="empty">正在加载故障切换链路…</p>'
    try {
      const items = (await api('/api/admin/usage/' + encodeURIComponent(requestId) + '/attempts')).items
      const rows = items.map((item) => '<tr><td>' + (item.attempt_no || item.attempt_number) + '</td><td>' + esc(item.channel_name_snapshot || item.current_channel_name || '—') + '</td><td>' + esc(item.upstream_model || '—') + '</td><td>' + (item.status_code ?? '网络错误') + '</td><td>' + esc(item.outcome || item.error_type || '—') + '</td><td>' + (item.latency_ms ?? item.duration_ms ?? 0) + ' ms</td><td>' + (item.is_final ? '最终' : '已切换') + '</td></tr>')
      host.innerHTML = '<p class="admin-section-title">请求 ' + esc(requestId) + ' 的渠道链路</p>' + table(['次序', '渠道', '上游模型', '状态', '结果', '耗时', '处理'], rows)
    } catch (error) { host.innerHTML = '<p class="form-error">' + esc(error.message) + '</p>' }
  }

  const mediaForm = $('#media-form')
  let mediaQuote = null, mediaNonce = null, mediaTimer = null, quoteTimer = null, quoteVersion = 0, mediaBusy = false, originalPrompt = null
  function mediaPayload() {
    const f = $('#media-form'); const p = Object.fromEntries(new FormData(f).entries())
    p.images = p.images.split(/\n/).map(s=>s.trim()).filter(Boolean)
    if(p.kind==='video') p.audios=p.audios.split(/\n/).map(s=>s.trim()).filter(Boolean)
    else { delete p.audios; delete p.mode; delete p.seconds; delete p.first_frame; delete p.last_frame }
    if(p.kind==='video')delete p.engine
    return p
  }
  function updateMediaControls() {
    const f=$('#media-form'),video=f.elements.kind.value==='video',engine=f.elements.engine?.value||'standard',singleResolution=!video&&engine!=='standard'
    $('#media-video-fields').classList.toggle('hidden',!video)
    $('#media-engine-field')?.classList.toggle('hidden',video)
    const sizes=video?['720P']:singleResolution?['1K']:['1K','2K','3K','4K']
    const selected=f.elements.size.value
    const activeSize=sizes.includes(selected)?selected:sizes[0]
    $('#media-size-options').innerHTML=sizes.map(size=>'<label><input type="radio" name="size" value="'+size+'" '+(size===activeSize?'checked':'')+'><span>'+size+'</span></label>').join('')
    const referenceUpload=$('#media-form [data-upload="images"]'),referenceLinks=$('#media-form [name="images"]')?.closest('label')
    referenceUpload?.classList.toggle('hidden',singleResolution)
    referenceLinks?.classList.toggle('hidden',singleResolution)
    if(singleResolution&&f.elements.images)f.elements.images.value=''
  }
  async function loadMedia() {
    if(mediaTimer)clearTimeout(mediaTimer)
    try {
      const [catalog,tasks] = await Promise.all([api('/api/me/media/catalog'),api('/api/me/media/tasks')])
      const f=$('#media-form'); const kind=f.elements.kind.value,engine=kind==='image'?(f.elements.engine?.value||'standard'):undefined
      const available=catalog.items.some(p=>p.kind===kind&&p.size===f.elements.size.value&&(kind!=='image'||(p.engine||'standard')===engine)&&p.available)
      $('#media-availability').textContent=available?(kind==='image'&&engine==='standard'?'标准图片免费生成，不冻结、不扣除钱包余额。':'输入描述后自动显示价格，成功生成后扣费。'):'此规格暂未开放，正在核实上游成本。'
      if(catalog.gift&&Number(catalog.gift.video_seconds_remaining)>0)$('#media-availability').textContent+=' 免费视频福利可用：720P 视频 '+catalog.gift.video_seconds_remaining+' 秒。'
      if(!mediaQuote && !mediaBusy) scheduleMediaQuote()
      const labels={queued:'排队中',submitting:'提交中',processing:'生成中',unknown:'待人工核实',completed:'已完成',failed:'失败，额度已释放'}
      $('#media-tasks').innerHTML=table(['类型 / 时间','进度','钱包额度','结果'],tasks.items.map(t=>'<tr><td>'+(t.kind==='video'?'视频生成':'图片生成')+'<small class="subline">'+date(t.createdAt)+'</small></td><td>'+esc(labels[t.status])+' '+Number(t.progress)+'%</td><td>'+money({micros:t.chargeMicros})+' · '+(t.gift?'免费福利 · '+(t.reserved?'使用中':t.status==='completed'?'已使用':'已退回'):t.charged?'已扣费':t.reserved?'冻结中':'已释放')+'</td><td>'+(t.resultUrl?'<a href="'+esc(t.resultUrl)+'" target="_blank" rel="noopener noreferrer">查看 / 下载作品</a>':esc(t.error||'等待生成'))+'</td></tr>'))
      if(tasks.items.some(t=>t.reserved)&&!document.hidden&&$('#view-media').classList.contains('active-view'))mediaTimer=setTimeout(loadMedia,5000)
    } catch(error){$('#media-error').textContent=error.message}
  }
  let mediaUploading=false
  $$('[data-upload-input]').forEach(input=>input.addEventListener('change',async()=>{
    const field=input.dataset.uploadInput, f=$('#media-form'), target=f.elements[field], status=$('[data-upload-status="'+field+'"]')
    if(mediaUploading||mediaBusy){input.value='';return}
    const files=[...input.files], old=target.value.split(/\n/).map(x=>x.trim()).filter(Boolean)
    const limit=field==='images'?(f.elements.kind.value==='image'?3:5):field==='audios'?3:1
    if(files.length+old.length>limit){status.textContent='最多 '+limit+' 个素材，请先移除现有素材或链接';input.value='';return}
    if(files.some(file=>file.size>20*1024*1024||!file.size)){status.textContent='文件为空或超过 20 MB';input.value='';return}
    mediaUploading=true;quoteVersion++;clearTimeout(quoteTimer);mediaQuote=null;$('#media-create').disabled=true
    const controls=[...f.querySelectorAll('input,select,textarea,button')];controls.forEach(c=>c.disabled=true)
    try{
      for(const [index,file] of files.entries()){
        status.textContent='正在上传 '+(index+1)+' / '+files.length+'：'+file.name
        const response=await fetch('/api/me/media/uploads',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/octet-stream'},body:file})
        const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'上传失败，请重试')
        if((field==='audios')!==result.contentType.startsWith('audio/')){await api('/api/me/media/uploads/'+result.token,{method:'DELETE'});throw new Error('素材类型不匹配，请选择'+(field==='audios'?'音频':'图片'))}
        target.value=[target.value.trim(),result.url].filter(Boolean).join('\n')
        const row=document.createElement('div');row.className='media-upload-item'
        const preview=document.createElement(field==='audios'?'audio':'img');preview.src=result.url;if(field==='audios')preview.controls=true;else preview.alt=file.name
        const label=document.createElement('span');label.textContent=file.name
        const remove=document.createElement('button');remove.type='button';remove.className='button';remove.textContent='移除';remove.addEventListener('click',()=>{target.value=target.value.split(/\n/).filter(u=>u.trim()!==result.url).join('\n');row.remove();scheduleMediaQuote()})
        row.append(preview,label,remove);$('[data-upload-list="'+field+'"]').append(row)
      }
      if(f.elements.kind.value==='video')f.elements.mode.value=['first_frame','last_frame'].includes(field)?'keyframe':'reference'
      status.textContent='上传完成，可继续编辑或生成。'
    }catch(e){status.textContent=e.message+'；已上传成功的素材已保留。'}
    finally{mediaUploading=false;controls.forEach(c=>c.disabled=false);input.value='';scheduleMediaQuote()}
  }))
  function scheduleMediaQuote() {
    clearTimeout(quoteTimer); const version=++quoteVersion
    mediaQuote=null; mediaNonce=null; $('#media-create').disabled=true
    $('#media-error').textContent=''
    if(!$('#media-prompt').value.trim()) {$('#media-quote').textContent='输入提示词后将自动显示本次价格';return}
    $('#media-quote').textContent='正在更新价格…'
    quoteTimer=setTimeout(async()=>{
      const payload=mediaPayload()
      try {
        const quote=await api('/api/me/media/quote',{method:'POST',body:JSON.stringify(payload)})
        if(version!==quoteVersion||mediaBusy||mediaUploading)return
        mediaQuote={...quote,payload};mediaNonce=crypto.randomUUID()
        const price=(Number(quote.chargeMicros)/1000000).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})
        $('#media-quote').textContent=quote.gift?'本次免费 · 使用 '+quote.gift.units+(quote.gift.kind==='image'?' 张标准图福利':' 秒视频福利')+'，失败退回免费额度':'本次价格 ¥'+price+' · 预扣钱包额度，成功后扣费'
        $('#media-create').disabled=false
      } catch(e){if(version!==quoteVersion)return;$('#media-quote').textContent='暂无法报价';$('#media-error').textContent=e.message}
    },350)
  }
  $('#media-form').addEventListener('input',scheduleMediaQuote)
  $('#media-form').addEventListener('change',event=>{
    if(event.target.name==='kind'||event.target.name==='engine'){updateMediaControls();scheduleMediaQuote();loadMedia()}
    else if(event.target.name==='size')loadMedia()
  })
  $('#media-refresh').addEventListener('click',loadMedia)
  $('#media-form').addEventListener('submit',event=>event.preventDefault())
  $('#media-create').addEventListener('click',async()=>{
    if(!mediaQuote||mediaBusy||mediaUploading)return
    const quote=mediaQuote, nonce=mediaNonce,button=$('#media-create');mediaBusy=true;pending(button,true,'提交中…')
    const controls=[...$('#media-form').querySelectorAll('input,select,textarea,button')];controls.forEach(c=>c.disabled=true)
    try{await api('/api/me/media/tasks',{method:'POST',body:JSON.stringify({...quote.payload,quoteToken:quote.quoteToken,idempotencyKey:nonce})});mediaQuote=null;toast('任务已提交，额度已冻结');await loadMedia()}
    catch(e){$('#media-error').textContent=e.message}
    finally{mediaBusy=false;controls.forEach(c=>c.disabled=false);pending(button,false);button.disabled=!mediaQuote;if(!mediaQuote)scheduleMediaQuote()}
  })
  $('#media-expand').addEventListener('click',async()=>{
    const prompt=$('#media-prompt'),before=prompt.value,kind=$('#media-form').elements.kind.value,button=$('#media-expand')
    if(!before.trim()){$('#media-expand-status').textContent='先写下你想生成的画面，再扩展提示词。';prompt.focus();return}
    pending(button,true,'扩展中…');$('#media-expand-status').textContent='正在补充画面细节…'
    try{
      const result=await api('/api/me/media/expand-prompt',{method:'POST',body:JSON.stringify({prompt:before,kind})})
      if(prompt.value!==before||$('#media-form').elements.kind.value!==kind){$('#media-expand-status').textContent='描述已修改，已保留你的最新输入。';return}
      originalPrompt=before;prompt.value=result.prompt;$('#media-restore').classList.remove('hidden');$('#media-expand-status').textContent=result.notice||'已扩展，可继续编辑或恢复原文。';scheduleMediaQuote()
    }catch(e){$('#media-expand-status').textContent=e.message}finally{pending(button,false)}
  })
  $('#media-restore').addEventListener('click',()=>{if(originalPrompt!==null){$('#media-prompt').value=originalPrompt;originalPrompt=null;$('#media-restore').classList.add('hidden');$('#media-expand-status').textContent='已恢复原文';scheduleMediaQuote()}})
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(mediaTimer)}else if($('#view-media').classList.contains('active-view')&&state.user)loadMedia()})
  updateMediaControls()
  let chatId=null, chatController=null, chatPoll=null, chatPending=null, chatEpoch=0
  const chatDrafts=new Map()
  const chatStorage=()=> 'chat-pending-'+state.user.id
  const chatVisible=()=> !document.hidden && $('#view-chat').classList.contains('active-view')
  function sizeChatInput(){const input=$('#chat-input');input.style.height='0px';input.style.height=Math.min(168,Math.max(56,input.scrollHeight))+'px'}
  function chatBusy(busy){$('#chat-send').classList.toggle('hidden',busy);$('#chat-stop').classList.toggle('hidden',!busy);$('#chat-input').readOnly=busy;$('#chat-new').disabled=busy;$('#chat-mobile-new').disabled=busy;$('#chat-delete').disabled=busy||!chatId;$('#chat-stop').disabled=!chatController}
  function chatBottom(){const b=$('#chat-messages');b.scrollTop=b.scrollHeight;$('#chat-latest').classList.add('hidden')}
  function chatNearBottom(){const b=$('#chat-messages');return b.scrollHeight-b.scrollTop-b.clientHeight<100}
  function chatSaveDraft(){chatDrafts.set(chatId||'new',$('#chat-input').value)}
  async function selectChat(id){if(chatController||chatPending)return;chatSaveDraft();chatId=id;$('#chat-input').value=chatDrafts.get(id)||'';sizeChatInput();$('#chat-history-dialog').close();await loadChat(true)}
  function chatArticle(role,text,status=false){const a=document.createElement('article');a.className='chat-message '+(role==='你'?'chat-user':'chat-answer');const label=document.createElement('strong');label.textContent=role;const p=document.createElement('p');p.textContent=text;if(status)p.className='chat-message-status';a.append(label,p);if(role==='AI'&&!status){const copy=document.createElement('button');copy.type='button';copy.className='chat-copy';copy.textContent='复制回答';copy.onclick=async()=>{try{await copyText(text);toast('回答已复制')}catch(e){toast(e.message,true)}};a.append(copy)}return a}
  function renderChat(items,force=false){const box=$('#chat-messages'),near=force||chatNearBottom(),top=box.scrollTop;box.replaceChildren();if(!items.length&&!chatPending){const empty=document.createElement('div');empty.className='chat-empty';const h=document.createElement('h4');h.textContent='今天，想聊些什么？';const p=document.createElement('p');p.textContent='写下问题，或从下面的灵感开始。';empty.append(h,p);for(const text of ['帮我安排一周简单又营养的晚餐','帮我写一段温暖的生日祝福','帮我规划一个轻松的周末']){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>{$('#chat-input').value=text;chatSaveDraft();sizeChatInput();$('#chat-input').focus()};empty.append(b)}box.append(empty)}
    for(const t of items){box.append(chatArticle('你',t.content));box.append(chatArticle('AI',t.status==='completed'?t.answer:t.error_message||'正在回复…',t.status!=='completed'))}
    if(chatPending&&chatPending.conversation===chatId&&!items.some(t=>t.request_id===chatPending.id)){box.append(chatArticle('你',chatPending.content),chatArticle('AI',chatPending.unknown?'正在确认结果，请勿重复发送…':'正在回复…',true))}
    if(near)chatBottom();else{box.scrollTop=top;$('#chat-latest').classList.remove('hidden')}
  }
  function scheduleChatPoll(){clearTimeout(chatPoll);if(chatVisible()&&chatPending)chatPoll=setTimeout(()=>loadChat(),3000)}
  async function loadChat(force=false){if(!state.user)return;const epoch=++chatEpoch;try{
    if(!chatPending){try{chatPending=JSON.parse(sessionStorage.getItem(chatStorage())||'null');if(chatPending&&!chatId)chatId=chatPending.conversation}catch{}}
    const [quota,list]=await Promise.all([api('/api/me/chat/quota'),api('/api/me/chat/conversations')]);if(epoch!==chatEpoch)return
    $('#chat-quota').textContent='今日剩余 '+Math.max(0,quota.limit-quota.used)+' / '+quota.limit+' 次'+(quota.platformAvailable?'':' · 全站今日次数已用完')
    if(!chatId&&list.items.length)chatId=list.items[0].id
    const current=list.items.find(t=>t.id===chatId);$('#chat-title').textContent=current?.title||'新对话';$('#chat-title').title=current?.title||'新对话'
    for(const selector of ['#chat-list','#chat-mobile-list']){const box=$(selector);box.replaceChildren();for(const item of list.items){const b=document.createElement('button');b.type='button';b.className='chat-history-item';b.textContent=item.title;b.title=item.title;b.setAttribute('aria-current',String(item.id===chatId));b.onclick=()=>selectChat(item.id).catch(e=>$('#chat-error').textContent=e.message);box.append(b)}}
    const result=chatId?await api('/api/me/chat/conversations/'+chatId+'/messages'):{items:[]};if(epoch!==chatEpoch)return
    const terminal=chatPending&&result.items.find(t=>t.request_id===chatPending.id&&t.status!=='pending')
    if(terminal){if(terminal.status==='completed'){$('#chat-input').value='';chatDrafts.delete(chatId);$('#chat-error').textContent=''}else{$('#chat-input').value=terminal.content;$('#chat-error').textContent=terminal.error_message||'生成失败，请重试'}chatPending=null;sessionStorage.removeItem(chatStorage());sizeChatInput()}
    const serverPending=result.items.find(t=>t.status==='pending');if(!chatPending&&serverPending){chatPending={id:serverPending.request_id,conversation:chatId,content:serverPending.content};sessionStorage.setItem(chatStorage(),JSON.stringify(chatPending))}
    if(chatPending?.unknown&&!chatController&&!result.items.some(t=>t.request_id===chatPending.id)){$('#chat-error').textContent='暂未查到提交记录。可点击发送重试，将沿用原请求编号。';chatPending.retryable=true}
    renderChat(result.items,force);chatBusy(Boolean(chatController||chatPending&&!chatPending.retryable));scheduleChatPoll()
  }catch(e){$('#chat-error').textContent=e.message;scheduleChatPoll()}}
  $('#chat-input').oninput=()=>{sizeChatInput();chatSaveDraft()}
  $('#chat-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229&&matchMedia('(min-width:801px) and (pointer:fine)').matches){e.preventDefault();$('#chat-form').requestSubmit()}}
  $('#chat-messages').onscroll=()=>$('#chat-latest').classList.toggle('hidden',chatNearBottom())
  $('#chat-latest').onclick=chatBottom
  $('#chat-refresh').onclick=()=>loadChat()
  $('#chat-history-open').onclick=()=>$('#chat-history-dialog').showModal()
  $('#chat-history-close').onclick=()=>$('#chat-history-dialog').close()
  $('#chat-history-dialog').onclick=e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close()}}
  $('#chat-delete').onclick=async()=>{if(!chatId||chatController||chatPending||!confirm('删除当前对话？对话将从历史列表移除，账单保留。'))return;try{await api('/api/me/chat/conversations/'+chatId,{method:'DELETE'});chatDrafts.delete(chatId);chatId=null;$('#chat-input').value='';await loadChat(true)}catch(e){$('#chat-error').textContent=e.message}}
  $('#chat-new').onclick=async()=>{if(chatController||chatPending)return;try{chatSaveDraft();const row=await api('/api/me/chat/conversations',{method:'POST',body:'{}'});chatId=row.id;$('#chat-input').value='';sizeChatInput();$('#chat-history-dialog').close();await loadChat(true);$('#chat-input').focus()}catch(e){$('#chat-error').textContent=e.message}}
  $('#chat-mobile-new').onclick=()=>$('#chat-new').click()
  $('#chat-stop').onclick=()=>{chatController?.abort();$('#chat-error').textContent='已请求停止，正在确认最终结果。'}
  $('#chat-form').onsubmit=async event=>{event.preventDefault();if(chatController||chatPending&&!chatPending.retryable)return;const content=$('#chat-input').value.trim();if(!content)return
    if(chatPending?.retryable&&content!==chatPending.content){$('#chat-error').textContent='上一条消息结果尚待确认，请先重试原消息或刷新记录。';return}
    chatController=new AbortController();chatBusy(true);$('#chat-error').textContent='';clearTimeout(chatPoll)
    try{if(!chatId)chatId=(await api('/api/me/chat/conversations',{method:'POST',body:'{}'})).id
      chatPending=chatPending||{conversation:chatId,content,id:crypto.randomUUID()};chatPending.retryable=false;chatPending.unknown=false;sessionStorage.setItem(chatStorage(),JSON.stringify(chatPending));
      const box=$('#chat-messages');if(box.querySelector('.chat-empty'))box.replaceChildren();if(!box.querySelector('[data-local-pending]')){const a=chatArticle('你',content);a.dataset.localPending='true';box.append(a,chatArticle('AI','正在回复…',true))}chatBottom()
      await api('/api/me/chat/conversations/'+chatId+'/messages',{method:'POST',body:JSON.stringify({content,requestId:chatPending.id}),signal:chatController.signal})
    }catch(e){if(chatPending){chatPending.unknown=true;sessionStorage.setItem(chatStorage(),JSON.stringify(chatPending))}$('#chat-error').textContent=e.name==='AbortError'?'已请求停止，正在确认最终结果。':e.message}
    finally{chatController=null;await loadChat(true);chatBusy(Boolean(chatPending&&!chatPending.retryable))}}
  document.addEventListener('visibilitychange',()=>{clearTimeout(chatPoll);if(chatVisible())loadChat()})
  if(window.visualViewport){const resize=()=>$('#view-chat').style.setProperty('--chat-viewport',window.visualViewport.height+'px');window.visualViewport.addEventListener('resize',resize);resize()}
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      const result = await api(state.registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password'), email: data.get('email'), verificationCode: data.get('verificationCode'), inviteCode: data.get('inviteCode'), termsAccepted: data.get('termsAccepted') === 'on' }) })
      state.user = result.user; $('#landing-view').classList.add('hidden'); history.replaceState(null, '', location.pathname === '/chat' ? '/chat' : '/'); $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden')
      if (result.user.role === 'admin') $('.admin-only').classList.remove('hidden')
      show(location.pathname === '/chat' ? 'chat' : 'overview')
    } catch (error) {
      $('#auth-error').textContent = error.message === '账号或密码错误'
        ? '账号或密码错误。账号不区分大小写，密码区分大小写；请检查自动填充、输入法全角字符和密码首尾空格。'
        : error.message
    }
  })
  $('#auth-toggle').addEventListener('click', () => { history.pushState(null, '', (state.registering ? '/login' : '/register') + location.search); showPublicRoute() })
  $('#toggle-auth-password').addEventListener('click', (event) => {
    const input = $('#auth-form [name="password"]'); const button = event.currentTarget; const visible = input.type === 'text'
    input.type = visible ? 'password' : 'text'; button.textContent = visible ? '显示' : '隐藏'
    button.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码'); button.setAttribute('aria-pressed', String(!visible))
  })
  $('#logout').addEventListener('click', async (event) => {
    const button = event.currentTarget
    pending(button, true, '退出中…')
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' })
      state.user = null
      if (state.overviewTimer) { clearInterval(state.overviewTimer); state.overviewTimer = null }
      $('#app-view').classList.add('hidden')
      $('#auth-view').classList.remove('hidden')
      $('#auth-error').textContent = ''
      registerMode(false)
      history.replaceState(null, '', '/')
      location.reload()
    } catch (error) {
      toast(error.message, true)
      pending(button, false)
    }
  })
  $('#change-password').addEventListener('click', () => {
    const form = $('#password-change-form'); form.reset(); $('#password-change-error').textContent = ''; $('#password-change-dialog').showModal(); form.elements.namedItem('currentPassword').focus()
  })
  $('#password-change-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries()); const button = form.querySelector('[type="submit"]')
    $('#password-change-error').textContent = ''; pending(button, true, '保存中…')
    try {
      await api('/api/me/password', { method: 'PATCH', body: JSON.stringify(data) })
      form.reset(); form.closest('dialog').close(); toast('密码已修改，请使用新密码登录'); await api('/api/auth/logout', { method: 'POST', body: '{}' }); location.reload()
    } catch (error) { $('#password-change-error').textContent = error.message } finally { pending(button, false) }
  })
  $$('#main-nav .nav-item').forEach((node) => node.addEventListener('click', (event) => { if(node.dataset.view==='chat') return; if(location.pathname==='/chat')history.pushState(null,'','/'); show(node.dataset.view) }))
  $$('[data-go]').forEach((node) => node.addEventListener('click', () => show(node.dataset.go)))
  $('#gallery-grid').addEventListener('click',async event=>{
    const button=event.target.closest('[data-gallery-delete]')
    if(!button||button.disabled||state.user?.role!=='admin')return
    if(!confirm('确定从广场删除「'+button.dataset.title+'」？删除后所有用户将无法在广场查看，原作品和账务记录保留。'))return
    pending(button,true,'删除中…')
    try{
      await api('/api/admin/media/tasks/'+encodeURIComponent(button.dataset.galleryDelete)+'/gallery',{method:'PATCH',body:JSON.stringify({status:'private',title:button.dataset.title})})
      button.closest('.gallery-item').remove()
      toast('作品已移出广场')
      if(!$('#gallery-grid .gallery-item'))await loadGallery()
    }catch(error){toast(error.message,true);pending(button,false)}
  })
  $('#gallery-refresh').addEventListener('click',loadGallery)
  $$('[data-gallery-kind]').forEach(button=>button.addEventListener('click',()=>{galleryKind=button.dataset.galleryKind;$$('[data-gallery-kind]').forEach(node=>node.classList.toggle('active',node===button));loadGallery()}))
  document.addEventListener('click', (event) => {
    const target = event.target; const copyButton = target.closest('[data-copy]'); const close = target.closest('[data-close-dialog]')
    if (copyButton) copy(copyButton.dataset.copy); if (close) document.getElementById(close.dataset.closeDialog)?.close()
  })
  $('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'))
  $('#usage-filters').addEventListener('submit', (event) => { event.preventDefault(); loadUsage(true) })
  $('#usage-more').addEventListener('click', () => loadUsage(false))
  $('#new-key').addEventListener('click', async () => {
    const name = prompt('Key 名称', '默认 Key'); if (!name) return
    try { const data = await api('/api/me/keys', { method: 'POST', body: JSON.stringify({ name }) }); const copied = await copyText(data.key.key).then(() => true).catch(() => false); alert((copied ? '完整 Key 已复制到剪贴板' : '请立即复制完整 Key') + '：\n\n' + data.key.key); loadKeys() } catch (error) { toast(error.message, true) }
  })
  $('#keys-table').addEventListener('click', async (event) => {
    const target = event.target; const reveal = target.closest('.reveal-key'); const imported = target.closest('.import-key'); const replacement = target.closest('.replace-key'); const revoke = target.closest('.revoke-key')
    if (reveal) return openReveal(reveal.dataset.id); if (imported) return importCcswitch(imported.dataset.id, imported); if (replacement) return $('#new-key').click()
    if (!revoke || !confirm('确定撤销此 Key？撤销后无法恢复。')) return
    pending(revoke, true, '撤销中…'); try { await api('/api/me/keys/' + encodeURIComponent(revoke.dataset.id), { method: 'DELETE' }); toast('已撤销'); loadKeys() } catch (error) { toast(error.message, true); pending(revoke, false) }
  })
  $('#key-reveal-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); pending(button, true, '验证中…')
    try {
      const data = await api('/api/me/keys/' + encodeURIComponent(state.revealKeyId) + '/reveal', { method: 'POST', body: JSON.stringify({ password: $('#key-reveal-password').value }) })
      $('#key-reveal-password').value = ''; $('#key-reveal-value').textContent = data.key; $('#key-reveal-result').classList.remove('hidden'); $('#key-password-field').classList.add('hidden'); $('#key-reveal-actions').classList.add('hidden'); $('#key-reveal-description').textContent = '完整 Key 已显示。复制后请关闭此窗口。'
    } catch (error) { $('#key-reveal-error').textContent = error.message } finally { pending(button, false) }
  })
  $('#topup-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); const data = new FormData(event.currentTarget); pending(button, true, '正在创建…')
    try { renderPayment(await api('/api/orders', { method: 'POST', body: JSON.stringify({ kind: 'wallet_topup', amountMicros: yuanToMicros(data.get('amount')).toString(), paymentMethod: 'wechat' }) })) } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  })
  $('#topup-form [name="amount"]').addEventListener('input', updateTopupCreditHint)
  $('#plans').addEventListener('click', async (event) => {
    const button = event.target.closest('.buy-plan'); if (!button) return; pending(button, true, '正在创建…')
    try { renderPayment(await api('/api/orders', { method: 'POST', body: JSON.stringify({ kind: 'subscription', planId: button.dataset.id, amountMicros: button.dataset.amount, paymentMethod: 'wechat' }) })) } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  })
  $('#affiliate-convert').addEventListener('click', async (event) => {
    const button = event.currentTarget; pending(button, true, '兑换中…')
    try { await api('/api/me/affiliate/convert', { method: 'POST', body: '{}' }); toast('返利已兑换到 API 钱包'); await Promise.all([loadAffiliate(), loadOverview()]) } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  })
  $('.admin-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-admin-tab]')
    if (tab) loadAdmin(tab.dataset.adminTab)
  })
  $('#admin-content').addEventListener('input', (event) => {
    const editor = event.target.closest('[data-admin-form]'); if (!editor) return
    if (editor.dataset.adminForm === 'channel-cost') previewChannelCost(editor)
    if (editor.dataset.adminForm === 'price' && (event.target.matches('[data-price-cost]') || event.target.matches('[data-margin]'))) calculateToken(editor)
    if (editor.dataset.adminForm === 'fixed-price' && (event.target.matches('[data-fixed-cost]') || event.target.matches('[data-fixed-margin]'))) { editor.dataset.manualSell = ''; calculateFixed(editor) }
    if (editor.dataset.adminForm === 'fixed-price' && event.target.matches('[data-fixed-sell]')) editor.dataset.manualSell = 'true'
  })
  $('#admin-content').addEventListener('change', (event) => {
    if (!event.target.closest('[data-admin-form="channel-cost"]')) return
    if (event.target.name === 'channelId') { state.selectedCostModel = null; refreshChannelCostEditor(true) }
    else if (event.target.name === 'modelPattern') refreshChannelCostEditor(false)
  })
  $('#admin-content').addEventListener('submit', async (event) => {
    event.preventDefault()
    const discountForm = event.target.closest('.inline-discount')
    if (discountForm) {
      const value = Number(new FormData(discountForm).get('discount'))
      if (!Number.isInteger(value) || value < 0 || value > 99) { toast('折扣必须为 0-99%', true); return }
      const button = discountForm.querySelector('button'); pending(button, true, '保存中…')
      try { await api('/api/admin/users/' + encodeURIComponent(discountForm.dataset.userId) + '/discount', { method: 'PATCH', body: JSON.stringify({ discountBps: value }) }); toast('用户折扣已保存'); await loadAdmin('users') } catch (error) { toast(error.message, true); pending(button, false) }
      return
    }
    const editor = event.target.closest('[data-admin-form]'); if (!editor) return
    try { await submitAdmin(editor) } catch (error) { toast(error.message, true) }
  })
  $('#admin-content').addEventListener('click', async (event) => {
    const target = event.target; const bootstrap = target.closest('[data-bootstrap]'); const edit = target.closest('.admin-edit'); const remove = target.closest('.admin-delete'); const attempts = target.closest('.admin-attempts'); const resetPlan = target.closest('.admin-reset-plan'); const walletAdjust = target.closest('.wallet-adjust')
    const cancelChannelEdit = target.closest('[data-cancel-channel-edit]')
    if (cancelChannelEdit) {
      const editor = cancelChannelEdit.closest('form'); editor.reset(); editor.elements.namedItem('id')?.remove()
      const key = editor.elements.namedItem('apiKey'); key.required = true; key.placeholder = ''
      editor.querySelector('[type="submit"]').textContent = '新增渠道'; cancelChannelEdit.remove(); editor.elements.namedItem('name').focus(); return
    }
    const mediaResolve=target.closest('[data-media-resolve]')
    if(mediaResolve){
      const reason=prompt('请填写在上游核实任务的依据（至少 5 字）；未核实请取消。');if(!reason)return
      const upstreamId=prompt('如已找到视频任务，填写 video_id 以恢复查询；留空则申请按失败释放。');if(upstreamId===null)return
      if(!upstreamId&&!confirm('确认已经在上游核实生成失败？这会释放用户冻结额度。'))return
      try{await api('/api/admin/media/tasks/'+encodeURIComponent(mediaResolve.dataset.mediaResolve)+'/resolve',{method:'POST',body:JSON.stringify({reason,upstreamId:upstreamId||undefined,confirmedFailed:!upstreamId})});await loadAdmin('media-admin')}catch(e){toast(e.message,true)}return
    }
    const galleryAction=target.closest('[data-gallery-action]')
    if(galleryAction){
      const id=galleryAction.dataset.id, action=galleryAction.dataset.galleryAction
      const title=$('[data-gallery-title="'+CSS.escape(id)+'"]')?.value.trim()||''
      const featured=galleryAction.dataset.featured==='true'
      const payload=action==='publish'?{status:'published',featured,title}:action==='feature'?{status:'published',featured:!featured,title}:action==='hide'?{status:'hidden',featured:false,title}:{status:'private',featured:false,title}
      const label=action==='publish'?'发布':action==='feature'?(payload.featured?'设为精选':'取消精选'):action==='hide'?'隐藏':'移出广场'
      if((action==='hide'||action==='private')&&!confirm('确认'+label+'此作品？历史生成记录和账单仍会保留。'))return
      pending(galleryAction,true,'处理中…')
      try{await api('/api/admin/media/tasks/'+encodeURIComponent(id)+'/gallery',{method:'PATCH',body:JSON.stringify(payload)});toast('作品已'+label);await loadAdmin('media-admin')}catch(error){toast(error.message,true);pending(galleryAction,false)}
      return
    }
    const refreshBalances=target.closest('[data-refresh-channel-balances]')
    if(refreshBalances){pending(refreshBalances,true,'查询中…');try{const data=await api('/api/admin/channels?refreshBalance=1');$('#admin-content').innerHTML=renderAdmin('channels',data);toast('上游余额已刷新')}catch(error){toast(error.message,true);pending(refreshBalances,false)}return}
    const channelButton = target.closest('[data-channel-action]')
    if (channelButton) { openChannelAction(channelButton); return }
    const costButton = target.closest('[data-channel-cost]')
    if (costButton) { state.selectedCostChannel = costButton.dataset.channelCost; state.selectedCostModel = null; await loadAdmin('channel-costs'); return }
    if (walletAdjust) {
      state.walletAdjustUserId = walletAdjust.dataset.id
      $('#wallet-adjust-user').textContent = '正在调整用户：' + (walletAdjust.dataset.username || '')
      const form = $('#wallet-adjust-form'); form.reset(); $('#wallet-adjust-error').textContent = ''; $('#wallet-adjust-dialog').showModal(); form.elements.namedItem('amountYuan').focus()
      return
    }
    if (resetPlan) {
      pending(resetPlan, true, '重置中…')
      try { await api('/api/admin/users/' + encodeURIComponent(resetPlan.dataset.id) + '/subscription/reset', { method: 'POST', body: '{}' }); toast('套餐额度已重置'); await loadAdmin('users') } catch (error) { toast(error.message, true); pending(resetPlan, false) }
      return
    }
    if (bootstrap) {
      pending(bootstrap, true, '初始化中…')
      try { const data = await api(bootstrap.dataset.bootstrap === 'openai-prices' ? '/api/admin/bootstrap/openai-prices' : '/api/admin/bootstrap/monthly-plan', { method: 'POST', body: '{}' }); toast(data.items ? '已初始化 ' + data.items.length + ' 个模型价格' : '月套餐已初始化'); await loadAdmin(state.adminTab) } catch (error) { toast(error.message, true) } finally { pending(bootstrap, false) }
      return
    }
    if (edit) { try { editAdmin(edit.dataset.kind, JSON.parse(edit.dataset.item)) } catch { toast('无法读取这条配置', true) }; return }
    if (remove) { try { await deleteAdmin(remove.dataset.kind, remove.dataset.id, remove) } catch (error) { toast(error.message, true) }; return }
    if (attempts) loadAttempts(attempts.dataset.id)
  })
  $('#channel-action-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!channelAction || $('#channel-action-submit').disabled) return
    const { id, archive } = channelAction
    const button = $('#channel-action-submit'); const cancel = $('#channel-action-cancel')
    pending(button, true, archive ? '删除中…' : '停用中…'); cancel.disabled = true; $('#channel-action-error').textContent = ''
    try {
      await api('/api/admin/channels/' + encodeURIComponent(id) + (archive ? '/archive' : ''), { method: 'DELETE' })
      $('#channel-action-dialog').close(); toast(archive ? '渠道已删除，历史记录已保留' : '渠道已停用')
      if (state.selectedCostChannel === id && archive) { state.selectedCostChannel = null; state.channelCostData = null }
      await loadAdmin('channels')
    } catch (error) { $('#channel-action-error').textContent = error.message } finally { pending(button, false); cancel.disabled = false }
  })
  $('#channel-action-dialog').addEventListener('cancel', event => { if ($('#channel-action-submit').disabled) event.preventDefault() })
  $('#channel-action-dialog').addEventListener('close', () => { channelAction = null })
  $('#wallet-adjust-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget; const data = Object.fromEntries(new FormData(form).entries()); const button = form.querySelector('[type="submit"]')
    pending(button, true, '处理中…'); $('#wallet-adjust-error').textContent = ''
    try { await api('/api/admin/users/' + encodeURIComponent(state.walletAdjustUserId || '') + '/wallet-adjustment', { method: 'POST', body: JSON.stringify(data) }); form.closest('dialog').close(); toast('钱包调账成功'); await loadAdmin('users') } catch (error) { $('#wallet-adjust-error').textContent = error.message } finally { pending(button, false) }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state.overviewTimer) { clearInterval(state.overviewTimer); state.overviewTimer = null } }
    else if (state.user && $('#view-overview')?.classList.contains('active-view') && !state.overviewTimer) { loadOverview(); state.overviewTimer = setInterval(() => loadOverview(), 30000) }
  })
  showPublicRoute()
  ;(async () => {
    loadSite()
    try {
      const data = await api('/api/auth/session'); if (!data.authenticated || !data.user) return; state.user = data.user; $('#landing-view').classList.add('hidden'); $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden'); $('#user-label').textContent = data.user.username
      if (data.user.role === 'admin') $('.admin-only').classList.remove('hidden')
      show(location.pathname === '/chat' ? 'chat' : 'overview')
    } catch { /* authentication view remains visible */ }
  })()
})()
