(() => {
  const state = { registering: false, user: null, usageCursor: null, adminTab: 'overview', revealKeyId: null }
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

  function toast(message, error = false) {
    const node = $('#toast')
    node.textContent = message
    node.className = error ? 'show error' : 'show'
    setTimeout(() => { node.className = '' }, 2600)
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
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
  async function loadSite() { try { applyBrand(await api('/api/public/site')) } catch { applyBrand(null) } }

  function registerMode(enabled) {
    state.registering = enabled
    for (const id of ['email-field', 'verification-field', 'invite-field', 'terms-field']) document.getElementById(id).classList.toggle('hidden', !enabled)
    $('#auth-title').textContent = enabled ? '创建账号' : '登录控制台'
    $('#auth-intro').textContent = enabled ? '完成邮箱验证后即可创建 API Key 并开始调用。' : '管理 API Key、额度、调用用量和接入配置。'
    $('#auth-submit').textContent = enabled ? '注册并登录' : '登录'
    $('#auth-toggle').textContent = enabled ? '已有账号？登录' : '没有账号？注册'
    $('#auth-form [name="email"]').required = enabled
    $('#auth-form [name="verificationCode"]').required = enabled
    $('#auth-form [name="termsAccepted"]').required = enabled
    $('#auth-form [name="password"]').autocomplete = enabled ? 'new-password' : 'current-password'
    $('#auth-error').textContent = ''
  }
  function applyInvite() {
    const code = new URLSearchParams(location.search).get('invite')?.trim()
    if (code && /^[a-z0-9_-]{6,64}$/i.test(code)) { registerMode(true); $('#auth-form [name="inviteCode"]').value = code.toUpperCase() }
  }
  function show(view) {
    $$('.view').forEach((node) => node.classList.toggle('active-view', node.id === 'view-' + view))
    $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view))
    const names = { overview: '总览', recharge: '充值与套餐', keys: 'API Keys', usage: '用量明细', affiliate: '邀请返利', downloads: '下载入口', admin: '管理后台' }
    $('#view-title').textContent = names[view] || '总览'
    $('.sidebar').classList.remove('open')
    if (view === 'overview') loadOverview()
    if (view === 'recharge') loadRecharge()
    if (view === 'keys') loadKeys()
    if (view === 'usage') { loadKeys(); loadUsage(true) }
    if (view === 'affiliate') loadAffiliate()
    if (view === 'downloads') loadDownloads()
    if (view === 'admin') loadAdmin(state.adminTab)
  }
  async function loadOverview() {
    try {
      const data = await api('/api/me/overview')
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
      $('#chatgpt-link').href = data.downloads.chatgpt; $('#ccswitch-link').href = data.downloads.ccswitch
      $('#quick-config').textContent = 'Base URL: ' + data.apiBaseUrl + '\nAuthorization: Bearer sk-relay-…'
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
      const plans = await api('/api/plans')
      $('#plans').innerHTML = plans.items.length ? plans.items.map((plan) => '<div class="plan-option"><div><strong>' + esc(plan.name) + '</strong><small>' + money({ micros: plan.price_micros }) + ' · 可消费额度 ' + money({ micros: plan.quota_micros }) + ' · 30 天</small></div><button class="button secondary buy-plan" type="button" data-id="' + esc(plan.id) + '" data-amount="' + esc(plan.price_micros) + '">购买</button></div>').join('') : '<p class="empty">管理员尚未配置套餐</p>'
    } catch (error) { toast(error.message, true) }
  }
  function renderPayment(data) {
    const payment = data.payment || {}; const provider = payment.provider === 'alipay' ? '支付宝' : '微信'; const raw = payment.qrCode || payment.codeUrl || ''
    const image = payment.qrImage || payment.qrDataUrl || data.qrImage || (String(raw).startsWith('data:image/') ? raw : '')
    const codeUrl = payment.codeUrl || (!String(raw).startsWith('data:image/') ? raw : '')
    $('#payment-result').classList.remove('hidden')
    $('#payment-result').innerHTML = '<div class="payment-layout">' + (image ? '<img class="payment-qr" src="' + esc(image) + '" alt="' + provider + '支付二维码">' : '') + '<div class="payment-details"><strong id="payment-status">订单已创建</strong><p id="payment-status-note">请使用' + provider + (image ? '扫描二维码' : '打开支付链接') + '完成支付，到账后余额会自动更新。</p>' + (codeUrl ? '<div class="copy-line"><code id="payment-code">' + esc(codeUrl) + '</code><button type="button" class="small-button" data-copy="payment-code">复制支付链接</button></div>' : '<p class="form-error">支付渠道未返回二维码，请稍后重试。</p>') + '</div></div>'
    if (data.orderId) {
      const started = Date.now(); const timer = setInterval(async () => {
        if (Date.now() - started > 31 * 60 * 1000) return clearInterval(timer)
        try { const order = await api('/api/me/orders/' + encodeURIComponent(data.orderId)); if (order.status === 'paid') { clearInterval(timer); $('#payment-status').textContent = '支付成功'; $('#payment-status-note').textContent = '余额已入账，正在刷新账户信息。'; await Promise.all([loadOverview(), loadRecharge()]) } else if (['failed', 'expired', 'closed'].includes(order.status)) { clearInterval(timer); const labels = { failed: '失败', expired: '已过期', closed: '已关闭' }; $('#payment-status').textContent = '订单' + (labels[order.status] || order.status); $('#payment-status-note').textContent = '请重新创建订单或联系管理员处理。' } } catch { /* keep polling while the session is valid */ }
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
    const rows = items.map((item) => compact
      ? '<tr><td>' + date(item.time) + '</td><td>' + esc(item.model) + '</td><td>' + integer(item.totalTokens) + '</td><td>' + money(item.charge) + '</td><td><span class="state ' + (item.success ? 'good' : 'bad') + '">' + (item.success ? '成功' : '失败') + '</span></td></tr>'
      : '<tr><td>' + date(item.time) + '</td><td><code>' + esc(item.requestId).slice(0, 12) + '…</code></td><td><strong>' + esc(item.model) + '</strong><small class="subline">' + esc(item.channel || '—') + '</small></td><td>' + integer(item.totalTokens) + '<small class="subline">入 ' + integer(item.inputTokens) + ' / 出 ' + integer(item.outputTokens) + '</small></td><td>' + money(item.charge) + '<small class="subline">套餐 ' + money(item.planCharge) + ' · 钱包 ' + money(item.walletCharge) + '</small>' + (item.profit ? '<small class="subline">成本 ' + money(item.estimatedCost) + ' · 利润 ' + money(item.profit) + '</small>' : '') + '</td><td><span class="state ' + (item.success ? 'good' : 'bad') + '">' + (item.statusCode ?? '—') + ' · ' + (item.success ? '成功' : '失败') + '</span></td></tr>').join('')
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
  async function loadDownloads() { try { const data = await api('/api/downloads'); $('#chatgpt-link').href = data.chatgpt; $('#ccswitch-link').href = data.ccswitch } catch (error) { toast(error.message, true) } }

  const field = (name, label, value = '', type = 'text', extra = '') => '<label>' + label + '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '" ' + extra + '></label>'
  const check = (name, label, checked = true) => '<label class="checkbox-label"><input name="' + name + '" type="checkbox" ' + (checked ? 'checked' : '') + '>' + label + '</label>'
  const form = (kind, fields, submit = '保存') => '<form class="admin-form" data-admin-form="' + kind + '">' + fields.join('') + '<div class="form-actions"><button class="button primary" type="submit">' + submit + '</button></div></form>'
  const table = (headings, rows, empty = '暂无数据') => rows.length ? '<div class="table-wrap scroll-table"><table><thead><tr>' + headings.map((heading) => '<th>' + esc(heading) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' : '<div class="table-wrap"><p class="empty">' + empty + '</p></div>'
  const rate = (row, name) => row[name + '_micros_per_million'] ?? row[name + '_micros'] ?? '0'

  function renderAdmin(tab, data) {
    const items = data.items || []
    if (tab === 'overview') {
      const m = data.metrics || {}; const mv = (v) => v?.yuan || '0'
      return '<div class="summary-strip"><span>请求 <strong>' + integer(m.requests) + '</strong></span><span>收入 <strong>' + mv(m.revenue) + '</strong></span><span>模型成本 <strong>' + mv(m.cost) + '</strong></span><span>毛利 <strong>' + mv(m.grossProfit) + '</strong></span><span>返利 <strong>' + mv(m.rebates) + '</strong></span><span>净利润 <strong>' + mv(m.netProfit) + '</strong></span></div><div class="notice">最低毛利线：' + ((data.minimumMarginBps || 3000) / 100) + '% · 未处理告警：' + (data.alerts || []).length + '</div>' + table(['渠道', '请求', '失败', '状态'], (data.channels || []).map((c) => '<tr><td>' + esc(c.name) + '</td><td>' + integer(c.requests) + '</td><td>' + integer(c.failures) + '</td><td>' + (c.circuit_open_until ? '<span class="state bad">熔断</span>' : '<span class="state good">正常</span>') + '</td></tr>'), '暂无渠道数据')
    }
    if (tab === 'channels') {
      const editor = form('channel', [field('name', '渠道名称', '', 'text', 'required'), field('baseUrl', '上游地址', '', 'url', 'required'), field('apiKey', '上游 Key', '', 'password', 'required'), field('priority', '优先级', '100', 'number', 'min="0"'), field('timeoutMs', '超时毫秒', '30000', 'number', 'min="1000" max="120000"'), field('modelMap', '模型映射 JSON', '{}'), check('enabled', '启用')], '新增渠道')
      const rows = items.map((item) => '<tr><td><strong>' + esc(item.name) + '</strong><small class="subline">' + esc(item.baseUrl) + '</small></td><td>' + item.priority + '</td><td>' + item.timeoutMs + ' ms</td><td><code class="inline-code">' + esc(JSON.stringify(item.modelMap || {})) + '</code></td><td><span class="state ' + (item.enabled ? 'good' : 'bad') + '">' + (item.enabled ? '启用' : '停用') + '</span></td><td class="admin-action-cell"><button class="small-button admin-edit" type="button" data-kind="channel" data-item="' + esc(JSON.stringify(item)) + '">编辑</button><button class="small-button danger-button admin-delete" type="button" data-kind="channel" data-id="' + esc(item.id) + '">停用</button></td></tr>')
      return editor + table(['渠道', '优先级', '超时', '模型映射', '状态', '操作'], rows, '尚未添加上游渠道')
    }
    if (tab === 'prices') {
      const inputs = ['input', 'output', 'cache'].flatMap((name) => [field(name + 'CostYuanPerMillion', (name === 'input' ? '输入' : name === 'output' ? '输出' : '缓存') + '成本（元/百万 Token）', '0', 'text', 'data-price-cost="' + name + '"'), field(name + 'SellYuanPerMillion', (name === 'input' ? '输入' : name === 'output' ? '输出' : '缓存') + '售价（元/百万 Token）', '0')])
      const editor = form('price', [field('modelPattern', '模型匹配', '*', 'text', 'required'), field('marginBps', '目标毛利率（基点）', '8000', 'number', 'min="0" max="9999" data-margin'), field('tierIncreasePercent', '272K+ 涨价比例（%）', '20', 'number', 'min="0" max="1000"'), ...inputs, check('active', '启用'), '<p class="admin-note wide">缓存按普通输入价计费；输入 Token 超过 272K 后自动使用涨价层。售价按目标毛利率自动计算；数据库仍以微元/百万 Token 保存。</p>'], '保存模型价格')
      const rows = items.map((item) => { const tiers = Array.isArray(item.pricing_tiers) ? item.pricing_tiers : []; const high = tiers.find((tier) => Number(tier.thresholdTokens) > 0); return '<tr><td><strong>' + esc(item.model_pattern) + '</strong><small class="subline">' + esc(item.price_source || '手工设置') + '</small></td><td>' + money({ micros: rate(item, 'input_sell') }) + (high ? '<small class="subline">272K+ ' + money({ micros: high.inputSellMicrosPerMillion }) + '</small>' : '') + '<small class="subline">成本 ' + money({ micros: rate(item, 'input_cost') }) + ' · ' + margin(rate(item, 'input_cost'), rate(item, 'input_sell')) + '</small></td><td>' + money({ micros: rate(item, 'output_sell') }) + (high ? '<small class="subline">272K+ ' + money({ micros: high.outputSellMicrosPerMillion }) + '</small>' : '') + '<small class="subline">成本 ' + money({ micros: rate(item, 'output_cost') }) + ' · ' + margin(rate(item, 'output_cost'), rate(item, 'output_sell')) + '</small></td><td>' + money({ micros: rate(item, 'cache_sell') }) + '</td><td><span class="state ' + (item.active ? 'good' : 'bad') + '">' + (item.active ? '启用' : '停用') + '</span></td><td class="admin-action-cell"><button class="small-button admin-edit" type="button" data-kind="price" data-item="' + esc(JSON.stringify(item)) + '">编辑</button><button class="small-button danger-button admin-delete" type="button" data-kind="price" data-id="' + esc(item.id) + '">停用</button></td></tr>' })
      return '<div class="admin-toolbar"><p>只会初始化已启用渠道实际映射的 OpenAI 模型。</p><button class="button secondary" type="button" data-bootstrap="openai-prices">按官方价格初始化</button></div>' + editor + table(['模型 / 来源', '输入售价', '输出售价', '缓存售价', '状态', '操作'], rows, '尚未配置模型价格')
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
    if (tab === 'users-discount') {
      return table(['用户', '钱包', 'Token 折扣', '套餐额度'], items.map((item) => {
        const discount = Number(item.token_discount_bps || 0) / 100
        return '<tr><td>' + esc(item.username) + '</td><td>' + money({ micros: item.balance_micros }) + '</td><td><form class="inline-discount" data-user-id="' + esc(item.id) + '"><input name="discount" type="number" min="0" max="99" value="' + esc(discount) + '"><button class="small-button" type="submit">保存</button></form></td><td>' + money({ micros: item.plan_remaining_micros }) + '</td></tr>'
      }))
    }
    if (tab === 'affiliate-admin') {
      const settings = Object.fromEntries((data.settings || []).map((item) => [item.key, item.value]))
      const editor = form('affiliate-settings', [field('rateBps', '返利比例（基点，1000 = 10%）', settings.affiliate_rate_bps || '1000', 'number', 'min="0" max="10000"'), check('enabled', '开启返利', settings.affiliate_enabled !== 'false')], '保存返利设置')
      const commission = (data.commissions || []).map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.inviter_username) + '</td><td>' + esc(item.invitee_username) + '</td><td>' + money({ micros: item.paid_amount_micros }) + '</td><td>' + (Number(item.rate_bps) / 100).toFixed(2) + '%</td><td>' + money({ micros: item.commission_micros }) + '</td></tr>')
      const conversion = (data.conversions || []).map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td>' + money({ micros: item.amount_micros }) + '</td><td>已完成</td></tr>')
      return editor + '<div><p class="admin-section-title">佣金流水</p>' + table(['时间', '邀请人', '被邀请人', '充值', '比例', '返利'], commission, '暂无佣金流水') + '</div><div><p class="admin-section-title">兑换流水</p>' + table(['时间', '用户', '兑换金额', '状态'], conversion, '暂无兑换流水') + '</div>'
    }
    if (tab === 'users') return table(['用户', '角色', '钱包', '套餐额度', '套餐到期 / 下次重置', '状态', '操作'], items.map((item) => '<tr><td><strong>' + esc(item.username) + '</strong><small class="subline">' + esc(item.email || '未验证邮箱') + '</small></td><td>' + esc(item.role) + '</td><td>' + money({ micros: item.balance_micros }) + '</td><td>' + (item.plan_status === 'active' ? money({ micros: item.plan_remaining_micros }) + ' / ' + money({ micros: item.plan_quota_micros }) : '—') + '</td><td>' + (item.plan_status === 'active' ? date(item.plan_expires_at) + '<small class="subline">下次 ' + date(item.plan_next_reset_at) + '</small>' : '—') + '</td><td><span class="state ' + (item.status === 'active' ? 'good' : 'bad') + '">' + esc(item.status) + '</span></td><td class="admin-action-cell"><button class="small-button wallet-adjust" type="button" data-id="' + esc(item.id) + '" data-username="' + esc(item.username) + '">充值/扣费</button>' + (item.plan_status === 'active' ? '<button class="small-button admin-reset-plan" type="button" data-id="' + esc(item.id) + '">重置额度</button>' : '') + '</td></tr>'))
    if (tab === 'orders') return table(['时间', '用户', '类型', '金额', '方式', '状态', '订单号'], items.map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td>' + esc(item.kind) + '</td><td>' + money({ micros: item.amount_micros }) + '</td><td>' + esc(item.payment_method) + '</td><td><span class="state ' + (item.status === 'paid' ? 'good' : 'bad') + '">' + esc(item.status) + '</span></td><td><code>' + esc(item.order_no) + '</code></td></tr>'))
    if (tab === 'admin-usage') {
      const rows = items.map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td><code>' + esc(item.request_id) + '</code></td><td>' + esc(item.requested_model) + '</td><td>' + esc(item.final_channel_name_snapshot || '—') + '</td><td>' + money({ micros: item.charge_micros }) + '</td><td>' + money({ micros: item.cost_micros }) + ' / ' + money({ micros: item.profit_micros }) + '</td><td><button class="small-button admin-attempts" type="button" data-id="' + esc(item.request_id) + '">链路</button></td></tr>')
      return table(['时间', '用户', '请求 ID', '模型', '最终渠道', '收费', '成本 / 利润', '操作'], rows) + '<div id="attempt-detail"></div>'
    }
    if (tab === 'resets') {
      const rows = items.map((item) => '<tr><td>' + date(item.created_at) + '</td><td>' + esc(item.username) + '</td><td>' + esc(item.reset_kind) + '</td><td>' + esc(item.actor_username || '系统') + '</td><td>' + money({ micros: item.before_remaining_micros }) + '</td><td>' + money({ micros: item.after_remaining_micros }) + '</td><td><code>' + esc(item.reset_key) + '</code></td></tr>')
      return table(['时间', '用户', '类型', '执行者', '重置前', '重置后', '周期标识'], rows, '暂无套餐重置记录')
    }
    if (tab === 'settings') {
      const settings = Object.fromEntries(items.map((item) => [item.key, item.value])); const smtp = data.mail || {}
      const editor = form('site-settings', [field('name', '站点名称', settings.site_name || 'GPT TOKEN', 'text', 'required'), field('title', '浏览器标题', settings.site_title || 'GPT TOKEN | OpenAI 兼容 API 控制台', 'text', 'required'), field('logoUrl', 'Logo 地址', settings.site_logo_url || '/assets/gpt-token-mark-192.png', 'text', 'required'), '<p class="admin-note wide">Logo 已本地托管。SMTP 密码、上游 Key 和用户 API Key 不会出现在本页面、数据库或日志。</p>'], '保存站点设置')
      return '<div class="settings-status"><div><span class="label">邮件服务</span><strong>' + (smtp.configured ? '已配置' : '未配置') + '</strong></div><div><span class="label">SMTP 主机</span><strong>' + esc(smtp.host || '—') + '</strong></div><div><span class="label">发件地址</span><strong>' + esc(smtp.from || '—') + '</strong></div><div><span class="label">TLS</span><strong>' + (smtp.secure ? '已启用' : '未启用') + '</strong></div></div>' + editor
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
    const endpoints = { overview: '/api/admin/overview', channels: '/api/admin/channels', prices: '/api/admin/prices', 'fixed-prices': '/api/admin/fixed-prices', plans: '/api/admin/plans', users: '/api/admin/users', orders: '/api/admin/orders', 'admin-usage': '/api/admin/usage', resets: '/api/admin/subscription-resets', 'affiliate-admin': '/api/admin/affiliate', settings: '/api/admin/settings' }
    try { $('#admin-content').innerHTML = renderAdmin(tab === 'users' ? 'users-discount' : tab, await api(endpoints[tab])) } catch (error) { toast(error.message, true) }
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
    const endpoints = { channel: '/api/admin/channels', price: '/api/admin/prices', 'fixed-price': '/api/admin/fixed-prices', plan: '/api/admin/plans', 'affiliate-settings': '/api/admin/affiliate/settings', 'site-settings': '/api/admin/settings/site' }
    const method = kind === 'affiliate-settings' ? 'PATCH' : kind === 'site-settings' ? 'PUT' : 'POST'
    const button = editor.querySelector('[type="submit"]'); pending(button, true, '保存中…')
    try { await api(endpoints[kind], { method, body: JSON.stringify(payload) }); toast('已保存'); if (kind === 'site-settings') await loadSite(); await loadAdmin(kind === 'affiliate-settings' ? 'affiliate-admin' : state.adminTab) } finally { pending(button, false) }
  }
  async function deleteAdmin(kind, id, button) {
    const endpoint = { channel: '/api/admin/channels/' + encodeURIComponent(id), price: '/api/admin/prices/' + encodeURIComponent(id), 'fixed-price': '/api/admin/fixed-prices/' + encodeURIComponent(id), plan: '/api/admin/plans/' + encodeURIComponent(id) }[kind]
    if (!confirm('确定停用这条配置？历史记录不会删除。')) return
    pending(button, true, '停用中…'); try { await api(endpoint, { method: 'DELETE' }); toast('已停用'); await loadAdmin(state.adminTab) } finally { pending(button, false) }
  }
  async function loadAttempts(requestId) {
    const host = $('#attempt-detail'); if (!host) return; host.innerHTML = '<p class="empty">正在加载故障切换链路…</p>'
    try {
      const items = (await api('/api/admin/usage/' + encodeURIComponent(requestId) + '/attempts')).items
      const rows = items.map((item) => '<tr><td>' + (item.attempt_no || item.attempt_number) + '</td><td>' + esc(item.channel_name_snapshot || item.current_channel_name || '—') + '</td><td>' + esc(item.upstream_model || '—') + '</td><td>' + (item.status_code ?? '网络错误') + '</td><td>' + esc(item.outcome || item.error_type || '—') + '</td><td>' + (item.latency_ms ?? item.duration_ms ?? 0) + ' ms</td><td>' + (item.is_final ? '最终' : '已切换') + '</td></tr>')
      host.innerHTML = '<p class="admin-section-title">请求 ' + esc(requestId) + ' 的渠道链路</p>' + table(['次序', '渠道', '上游模型', '状态', '结果', '耗时', '处理'], rows)
    } catch (error) { host.innerHTML = '<p class="form-error">' + esc(error.message) + '</p>' }
  }

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      const result = await api(state.registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password'), email: data.get('email'), verificationCode: data.get('verificationCode'), inviteCode: data.get('inviteCode'), termsAccepted: data.get('termsAccepted') === 'on' }) })
      state.user = result.user; $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden')
      if (result.user.role === 'admin') $('.admin-only').classList.remove('hidden')
      show('overview')
    } catch (error) { $('#auth-error').textContent = error.message }
  })
  $('#auth-toggle').addEventListener('click', () => registerMode(!state.registering))
  $('#send-verification-code').addEventListener('click', async (event) => {
    const button = event.currentTarget; pending(button, true, '发送中…')
    try {
      const data = await api('/api/auth/email-verification', { method: 'POST', body: JSON.stringify({ email: $('#auth-form [name="email"]').value.trim() }) })
      toast('验证码已发送，有效至 ' + new Date(data.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
      $('#auth-form [name="verificationCode"]').focus()
    } catch (error) { $('#auth-error').textContent = error.message } finally { pending(button, false) }
  })
  $('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload() })
  $$('#main-nav .nav-item').forEach((node) => node.addEventListener('click', () => show(node.dataset.view)))
  $$('[data-go]').forEach((node) => node.addEventListener('click', () => show(node.dataset.go)))
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
    try { renderPayment(await api('/api/orders', { method: 'POST', body: JSON.stringify({ kind: 'wallet_topup', amountMicros: yuanToMicros(data.get('amount')).toString(), paymentMethod: data.get('paymentMethod') }) })) } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  })
  $('#plans').addEventListener('click', async (event) => {
    const button = event.target.closest('.buy-plan'); if (!button) return; pending(button, true, '正在创建…')
    try { renderPayment(await api('/api/orders', { method: 'POST', body: JSON.stringify({ kind: 'subscription', planId: button.dataset.id, amountMicros: button.dataset.amount, paymentMethod: $('#plan-payment-method').value }) })) } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  })
  $('#affiliate-convert').addEventListener('click', async (event) => {
    const button = event.currentTarget; pending(button, true, '兑换中…')
    try { await api('/api/me/affiliate/convert', { method: 'POST', body: '{}' }); toast('返利已兑换到 API 钱包'); await Promise.all([loadAffiliate(), loadOverview()]) } catch (error) { toast(error.message, true) } finally { pending(button, false) }
  })
  $$('.admin-tabs .tab').forEach((node) => node.addEventListener('click', () => loadAdmin(node.dataset.adminTab)))
  $('#admin-content').addEventListener('input', (event) => {
    const editor = event.target.closest('[data-admin-form]'); if (!editor) return
    if (editor.dataset.adminForm === 'price' && (event.target.matches('[data-price-cost]') || event.target.matches('[data-margin]'))) calculateToken(editor)
    if (editor.dataset.adminForm === 'fixed-price' && (event.target.matches('[data-fixed-cost]') || event.target.matches('[data-fixed-margin]'))) { editor.dataset.manualSell = ''; calculateFixed(editor) }
    if (editor.dataset.adminForm === 'fixed-price' && event.target.matches('[data-fixed-sell]')) editor.dataset.manualSell = 'true'
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
    if (walletAdjust) {
      const direction = prompt('输入 credit 充值或 debit 扣费', 'credit')?.trim().toLowerCase(); if (!direction) return
      const amount = prompt('请输入金额（元）', '10')?.trim(); if (!amount) return
      const note = prompt('请输入调账原因（必填）', '管理员人工调账')?.trim(); if (!note) return
      pending(walletAdjust, true, '处理中…')
      try { await api('/api/admin/users/' + encodeURIComponent(walletAdjust.dataset.id) + '/wallet-adjustment', { method: 'POST', body: JSON.stringify({ direction, amountYuan: amount, note }) }); toast('钱包调账成功'); await loadAdmin('users') } catch (error) { toast(error.message, true); pending(walletAdjust, false) }
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
  applyInvite()
  ;(async () => {
    await loadSite()
    try {
      const data = await api('/api/auth/me'); state.user = data.user; $('#auth-view').classList.add('hidden'); $('#app-view').classList.remove('hidden'); $('#user-label').textContent = data.user.username
      if (data.user.role === 'admin') $('.admin-only').classList.remove('hidden')
      show('overview')
    } catch { /* authentication view remains visible */ }
  })()
})()
