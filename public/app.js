(() => {
  const state = { registering: false, user: null, overview: null, usageCursor: null, adminTab: 'channels' }
  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => [...document.querySelectorAll(selector)]
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
  const date = (value) => value
    ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—'
  const toMicros = (value) => {
    const raw = typeof value === 'object' && value !== null ? value.micros : value
    try { return BigInt(String(raw ?? 0).trim() || '0') } catch { return 0n }
  }
  const microsMoney = (value) => {
    const amount = toMicros(value)
    const negative = amount < 0n
    const cents = ((negative ? -amount : amount) + 5_000n) / 10_000n
    return `${negative ? '-' : ''}¥${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
  }
  const yuanToMicros = (value) => {
    const source = String(value ?? '').trim()
    if (!/^\d+(?:\.\d{1,6})?$/.test(source)) throw new Error('金额格式无效')
    const [whole, fraction = ''] = source.split('.')
    return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString()
  }
  const money = (value) => {
    if (value == null) return '¥0.00'
    if (typeof value === 'object' && value.micros !== undefined) return microsMoney(value.micros)
    try { return microsMoney(yuanToMicros(value)) } catch { return '¥0.00' }
  }
  const balanceMicros = (value) => {
    if (value && typeof value === 'object' && value.micros !== undefined) return toMicros(value.micros)
    try { return toMicros(yuanToMicros(value)) } catch { return 0n }
  }
  const signedMicrosMoney = (value) => {
    const amount = toMicros(value)
    return `${amount > 0n ? '+' : ''}${microsMoney(amount)}`
  }
  const formatInteger = (value) => {
    const amount = toMicros(value)
    const negative = amount < 0n
    const digits = String(negative ? -amount : amount)
    return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
  }

  function toast(message, error = false) {
    const node = $('#toast')
    node.textContent = message
    node.className = error ? 'show error' : 'show'
    window.setTimeout(() => { node.className = '' }, 2600)
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || data.message || `请求失败（${response.status}）`)
    return data
  }

  async function copyText(value) {
    if (!value) throw new Error('没有可复制的内容')
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value)
        return
      } catch {
        // Continue with the compatibility fallback.
      }
    }
    const input = document.createElement('textarea')
    input.value = value
    input.setAttribute('readonly', '')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    input.setSelectionRange(0, input.value.length)
    const copied = document.execCommand('copy')
    input.remove()
    if (!copied) throw new Error('复制失败，请手动复制')
  }

  async function copy(id) {
    const value = document.getElementById(id)?.textContent?.trim()
    if (!value || value === '--') return
    try {
      await copyText(value)
      toast('已复制')
    } catch (error) {
      toast(error.message, true)
    }
  }

  function setPending(button, pending, pendingLabel = '处理中…') {
    if (!button) return
    if (pending) {
      button.dataset.label = button.textContent
      button.textContent = pendingLabel
      button.disabled = true
      return
    }
    button.textContent = button.dataset.label || button.textContent
    button.disabled = false
  }

  function applyInviteFromUrl() {
    const invite = new URLSearchParams(window.location.search).get('invite')?.trim()
    if (!invite || !/^[a-z0-9_-]{6,64}$/i.test(invite)) return
    state.registering = true
    $('#invite-field').classList.remove('hidden')
    $('#auth-submit').textContent = '注册并登录'
    $('#auth-toggle').textContent = '已有账号？登录'
    $('#auth-form [name="inviteCode"]').value = invite.toUpperCase()
  }

  function show(view) {
    $$('.view').forEach((node) => node.classList.toggle('active-view', node.id === `view-${view}`))
    $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view))
    const names = {
      overview: ['工作台', '总览'],
      recharge: ['账户资金', '充值与套餐'],
      keys: ['访问凭证', 'API Keys'],
      usage: ['消费审计', '用量明细'],
      affiliate: ['邀请计划', '邀请返利'],
      downloads: ['开始使用', '下载入口'],
      admin: ['运维配置', '管理后台'],
    }
    const [kicker, title] = names[view] || names.overview
    $('#view-kicker').textContent = kicker
    $('#view-title').textContent = title
    $('.sidebar').classList.remove('open')
    if (view === 'overview') loadOverview()
    if (view === 'recharge') loadRecharge()
    if (view === 'keys') loadKeys()
    if (view === 'usage') { loadKeys(); loadUsage(true) }
    if (view === 'affiliate') loadAffiliate()
    if (view === 'downloads') loadDownloads()
    if (view === 'admin') loadAdmin('channels')
  }

  async function loadOverview() {
    try {
      const data = await api('/api/me/overview')
      state.overview = data
      state.user = data.user
      $('#user-label').textContent = data.user.username
      $('#balance-total').textContent = microsMoney(balanceMicros(data.balance.wallet) + balanceMicros(data.balance.planRemaining))
      $('#balance-detail').textContent = `钱包 ${money(data.balance.wallet)} · 套餐 ${money(data.balance.planRemaining)}`
      $('#plan-expiry').textContent = data.balance.planExpiresAt
        ? new Date(data.balance.planExpiresAt).toLocaleDateString('zh-CN')
        : '未开通'
      $('#api-base').textContent = data.apiBaseUrl
      $('#account-state').textContent = data.balance.isValid ? '有效' : '需充值'
      $('#chatgpt-link').href = data.downloads.chatgpt
      $('#ccswitch-link').href = data.downloads.ccswitch
      $('#quick-config').textContent = `Base URL: ${data.apiBaseUrl}\nAuthorization: Bearer sk-relay-…`
      const usage = await api('/api/me/usage?limit=5')
      renderUsageRows('#recent-usage', usage.items, true)
    } catch (error) {
      toast(error.message, true)
    }
  }

  async function loadKeys() {
    try {
      const data = await api('/api/me/keys')
      populateUsageKeyFilter(data.items)
      $('#keys-table').innerHTML = data.items.length
        ? data.items.map((key) => `<tr>
            <td>${esc(key.name)}</td>
            <td><code>${esc(key.prefix)}…</code></td>
            <td>${date(key.createdAt)}</td>
            <td>${key.lastUsedAt ? date(key.lastUsedAt) : '从未'}</td>
            <td><span class="state ${key.revoked ? 'bad' : 'good'}">${key.revoked ? '已撤销' : '启用'}</span></td>
            <td>${key.revoked ? '—' : `<div class="row-actions"><button type="button" class="small-button import-key" data-id="${esc(key.id)}">导入 CC Switch</button><button type="button" class="small-button danger-button revoke-key" data-id="${esc(key.id)}">撤销</button></div>`}</td>
          </tr>`).join('')
        : '<tr><td colspan="6" class="empty">还没有 API Key，创建后即可调用模型</td></tr>'
    } catch (error) {
      toast(error.message, true)
    }
  }

  function populateUsageKeyFilter(items = []) {
    const select = $('#usage-key-filter')
    if (!select) return
    const selected = select.value
    select.innerHTML = `<option value="">全部 Key</option>${items.map((key) => `<option value="${esc(key.id)}">${esc(key.name)}${key.revoked ? '（已撤销）' : ''}</option>`).join('')}`
    if ([...select.options].some((option) => option.value === selected)) select.value = selected
  }

  async function importCcswitch(keyId, button) {
    setPending(button, true, '正在打开…')
    try {
      const data = await api(`/api/me/keys/${encodeURIComponent(keyId)}/ccswitch`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const link = data.importUrl || data.link
      if (!link?.startsWith('ccswitch://')) throw new Error('服务端未返回有效的导入链接')
      const copied = await copyText(link).then(() => true).catch(() => false)
      const launcher = document.createElement('a')
      launcher.href = link
      launcher.hidden = true
      document.body.appendChild(launcher)
      launcher.click()
      launcher.remove()
      toast(copied ? '正在打开 CC Switch，导入链接也已复制' : '正在打开 CC Switch')
    } catch (error) {
      toast(error.message, true)
    } finally {
      setPending(button, false)
    }
  }

  async function loadRecharge() {
    try {
      const plans = await api('/api/plans')
      $('#plans').innerHTML = plans.items.length
        ? plans.items.map((plan) => `<div class="plan-option"><div><strong>${esc(plan.name)}</strong><small>${microsMoney(plan.price_micros)} · 额度 ${microsMoney(plan.quota_micros)} · 30 天</small></div><button class="button secondary buy-plan" data-id="${esc(plan.id)}" data-amount="${esc(plan.price_micros)}">购买</button></div>`).join('')
        : '<p class="empty">管理员尚未配置套餐</p>'
    } catch (error) {
      toast(error.message, true)
    }
  }

  function renderPayment(data) {
    const payment = data.payment || {}
    const providerName = payment.provider === 'alipay' ? '支付宝' : '微信'
    const rawQrValue = payment.qrCode || payment.codeUrl || ''
    const image = payment.qrImage
      || payment.qrDataUrl
      || payment.qrCodeDataUrl
      || data.qrImage
      || data.qrDataUrl
      || (String(rawQrValue).startsWith('data:image/') ? rawQrValue : '')
    const codeUrl = payment.codeUrl || (!String(rawQrValue).startsWith('data:image/') ? rawQrValue : '')
    const result = $('#payment-result')
    result.classList.remove('hidden')
    result.innerHTML = `<div class="payment-layout">
      ${image ? `<img class="payment-qr" src="${esc(image)}" alt="${providerName}支付二维码">` : ''}
      <div class="payment-details">
        <strong>订单已创建</strong>
        <p>请使用${providerName}${image ? '扫描二维码' : '打开支付链接'}完成支付，到账后余额会自动更新。</p>
        ${codeUrl ? `<div class="copy-line payment-code"><code id="payment-code">${esc(codeUrl)}</code><button type="button" class="small-button" data-copy="payment-code">复制支付链接</button></div>` : '<p class="form-error">支付渠道未返回二维码，请稍后重试。</p>'}
      </div>
    </div>`
  }

  async function loadUsage(reset = false) {
    try {
      if (reset) state.usageCursor = null
      const form = new FormData($('#usage-filters'))
      const params = new URLSearchParams({ limit: '50' })
      for (const [key, value] of form.entries()) if (value) params.set(key, value)
      if (state.usageCursor) params.set('cursor', state.usageCursor)
      const data = await api(`/api/me/usage?${params}`)
      renderUsageRows('#usage-table', data.items, false, !reset)
      state.usageCursor = data.nextCursor
      $('#usage-more').classList.toggle('hidden', !data.nextCursor)
      $('#usage-summary').innerHTML = `<span>请求 <strong>${formatInteger(data.summary.requests)}</strong></span><span>收费 <strong>${money(data.summary.charge)}</strong></span><span>套餐扣费 <strong>${money(data.summary.planCharge)}</strong></span><span>钱包扣费 <strong>${money(data.summary.walletCharge)}</strong></span><span>成本 <strong>${money(data.summary.estimatedCost)}</strong></span><span>利润 <strong>${money(data.summary.profit)}</strong></span><span>输入 Token <strong>${formatInteger(data.summary.inputTokens)}</strong></span><span>输出 Token <strong>${formatInteger(data.summary.outputTokens)}</strong></span>`
    } catch (error) {
      toast(error.message, true)
    }
  }

  function renderUsageRows(selector, items, compact = false, append = false) {
    const body = $(selector)
    if (!items?.length) {
      if (!append) body.innerHTML = `<tr><td colspan="${compact ? 5 : 6}" class="empty">暂无用量记录</td></tr>`
      return
    }
    const rows = items.map((item) => compact
      ? `<tr><td>${date(item.time)}</td><td>${esc(item.model)}</td><td>${formatInteger(item.totalTokens)}</td><td>${money(item.charge)}</td><td><span class="state ${item.success ? 'good' : 'bad'}">${item.success ? '成功' : '失败'}</span></td></tr>`
      : `<tr><td>${date(item.time)}</td><td><code>${esc(item.requestId).slice(0, 12)}…</code></td><td><strong>${esc(item.model)}</strong><small class="subline">${esc(item.channel || '—')}</small></td><td>${formatInteger(item.totalTokens)}<small class="subline">入 ${formatInteger(item.inputTokens)} / 出 ${formatInteger(item.outputTokens)}</small></td><td>${money(item.charge)}<small class="subline">套餐 ${money(item.planCharge)} · 钱包 ${money(item.walletCharge)}</small><small class="subline">成本 ${money(item.estimatedCost)} · 利润 ${money(item.profit)}</small></td><td><span class="state ${item.success ? 'good' : 'bad'}">${item.statusCode ?? '—'} · ${item.success ? '成功' : '失败'}</span></td></tr>`)
      .join('')
    if (append) body.insertAdjacentHTML('beforeend', rows)
    else body.innerHTML = rows
  }

  async function loadAffiliate() {
    try {
      const data = await api('/api/me/affiliate')
      $('#affiliate-balance').textContent = microsMoney(data.balanceMicros)
      $('#affiliate-lifetime').textContent = microsMoney(data.lifetimeMicros)
      $('#affiliate-converted').textContent = microsMoney(data.convertedMicros)
      $('#invite-code').textContent = data.inviteCode
      $('#invite-link').textContent = `${location.origin}${data.inviteLink}`
      $('#invite-count').textContent = data.invitedCount
      $('#affiliate-convert').disabled = toMicros(data.balanceMicros) <= 0n

      $('#affiliate-table').innerHTML = data.commissions?.length
        ? data.commissions.map((row) => {
            const percentage = Number(row.rateBps) / 100
            const rateLabel = Number.isFinite(percentage) ? `${percentage.toFixed(2).replace(/\.?0+$/, '') || '0'}%` : '—'
            return `<tr><td>${date(row.createdAt)}</td><td>${esc(row.invitedUsername)}</td><td>${microsMoney(row.paidAmountMicros)}</td><td>${rateLabel}</td><td class="amount-positive">+${microsMoney(row.commissionMicros)}</td></tr>`
          }).join('')
        : '<tr><td colspan="5" class="empty">还没有返利记录，分享邀请码后会显示在这里</td></tr>'

      const labels = {
        commission_credit: '返利入账',
        commission: '返利入账',
        conversion_debit: '兑换到钱包',
        convert: '兑换到钱包',
        admin_adjustment: '人工调整',
        reversal: '返利冲正',
      }
      $('#affiliate-ledger').innerHTML = data.ledger?.length
        ? data.ledger.map((row) => {
            const amount = toMicros(row.amountMicros)
            return `<tr><td>${date(row.createdAt)}</td><td>${labels[row.kind] || esc(row.kind)}</td><td class="${amount >= 0n ? 'amount-positive' : 'amount-negative'}">${signedMicrosMoney(row.amountMicros)}</td><td>${microsMoney(row.balanceAfterMicros)}</td></tr>`
          }).join('')
        : '<tr><td colspan="4" class="empty">暂无资金记录</td></tr>'
    } catch (error) {
      toast(error.message, true)
    }
  }

  async function loadDownloads() {
    try {
      const data = await api('/api/downloads')
      $('#chatgpt-link').href = data.chatgpt
      $('#ccswitch-link').href = data.ccswitch
    } catch (error) {
      toast(error.message, true)
    }
  }

  async function loadAdmin(tab) {
    state.adminTab = tab
    $$('.admin-tabs .tab').forEach((node) => node.classList.toggle('active', node.dataset.adminTab === tab))
    try {
      const endpoint = {
        channels: '/api/admin/channels',
        prices: '/api/admin/prices',
        'fixed-prices': '/api/admin/fixed-prices',
        plans: '/api/admin/plans',
        users: '/api/admin/users',
        orders: '/api/admin/orders',
        'admin-usage': '/api/admin/usage',
        'affiliate-admin': '/api/admin/affiliate',
        settings: '/api/admin/settings',
      }[tab]
      const data = await api(endpoint)
      $('#admin-content').innerHTML = renderAdmin(tab, data)
    } catch (error) {
      toast(error.message, true)
    }
  }

  const rowTable = (headers, rows, empty = '暂无数据') => rows.length
    ? `<div class="table-wrap scroll-table"><table><thead><tr>${headers.map((label) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="table-wrap"><p class="empty">${empty}</p></div>`

  const input = (name, label, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`
  const check = (name, label, value = true) => `<label class="checkbox-label"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`
  const adminForm = (kind, fields, submit = '保存') => `<form class="admin-form" data-admin-form="${kind}">${fields.join('')}<div class="form-actions"><button type="submit" class="button primary">${submit}</button></div></form>`

  function modelRate(row, name) {
    return row[`${name}_micros_per_million`] ?? row[`${name}_micros`] ?? '0'
  }

  function renderAdmin(tab, data) {
    const items = data.items || []
    if (tab === 'channels') {
      const form = adminForm('channel', [
        input('name', '渠道名称', '', 'text', 'required'), input('baseUrl', '上游地址', '', 'url', 'required placeholder="https://api.example.com"'),
        input('apiKey', '上游 Key', '', 'password', 'required'), input('priority', '优先级', '100', 'number', 'min="0"'),
        input('timeoutMs', '超时毫秒', '30000', 'number', 'min="1000" max="120000"'), input('modelMap', '模型映射 JSON', '{}'), check('enabled', '启用', true),
      ], '新增渠道')
      const rows = items.map((item) => `<tr><td><strong>${esc(item.name)}</strong><small class="subline">${esc(item.baseUrl)}</small></td><td>${item.priority}</td><td>${item.timeoutMs} ms</td><td><code class="inline-code">${esc(JSON.stringify(item.modelMap || {}))}</code></td><td><span class="state ${item.enabled ? 'good' : 'bad'}">${item.enabled ? '启用' : '停用'}</span></td><td>${item.failureCount}${item.circuitOpenUntil ? '<small class="subline">熔断中</small>' : ''}</td><td class="admin-action-cell"><button class="small-button admin-edit" data-kind="channel" data-item="${esc(JSON.stringify(item))}">编辑</button><button class="small-button danger-button admin-delete" data-kind="channel" data-id="${esc(item.id)}">停用</button></td></tr>`)
      return `${form}${rowTable(['渠道', '优先级', '超时', '模型映射', '状态', '失败', '操作'], rows, '尚未添加上游渠道')}`
    }
    if (tab === 'prices') {
      const form = adminForm('price', [
        input('modelPattern', '模型匹配', '*', 'text', 'required'), check('active', '启用', true),
        input('inputCostMicrosPerMillion', '输入成本（微元/百万）', '0', 'number', 'min="0"'), input('inputSellMicrosPerMillion', '输入售价（微元/百万）', '0', 'number', 'min="0"'),
        input('outputCostMicrosPerMillion', '输出成本（微元/百万）', '0', 'number', 'min="0"'), input('outputSellMicrosPerMillion', '输出售价（微元/百万）', '0', 'number', 'min="0"'),
        input('cacheCostMicrosPerMillion', '缓存成本（微元/百万）', '0', 'number', 'min="0"'), input('cacheSellMicrosPerMillion', '缓存售价（微元/百万）', '0', 'number', 'min="0"'),
      ], '保存模型价格')
      const rows = items.map((item) => `<tr><td><strong>${esc(item.model_pattern)}</strong></td><td>${microsMoney(modelRate(item, 'input_sell'))}</td><td>${microsMoney(modelRate(item, 'output_sell'))}</td><td>${microsMoney(modelRate(item, 'cache_sell'))}</td><td>${microsMoney(modelRate(item, 'input_cost'))} / ${microsMoney(modelRate(item, 'output_cost'))}</td><td><span class="state ${item.active ? 'good' : 'bad'}">${item.active ? '启用' : '停用'}</span></td><td class="admin-action-cell"><button class="small-button admin-edit" data-kind="price" data-item="${esc(JSON.stringify(item))}">编辑</button><button class="small-button danger-button admin-delete" data-kind="price" data-id="${esc(item.id)}">停用</button></td></tr>`)
      return `${form}${rowTable(['模型', '输入售价', '输出售价', '缓存售价', '输入/输出成本', '状态', '操作'], rows, '尚未配置模型价格')}`
    }
    if (tab === 'fixed-prices') {
      const form = adminForm('fixed-price', [
        `<label>方法<select name="httpMethod"><option>ANY</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label>`, input('pathPattern', '接口路径', '/v1/images/generations', 'text', 'required'),
        input('requestedModel', '限定模型（可选）'), input('costMicros', '固定成本（微元）', '0', 'number', 'min="0"'), input('sellMicros', '固定售价（微元）', '0', 'number', 'min="0"'), input('matchPriority', '匹配优先级', '100', 'number', 'min="0"'), check('enabled', '启用', true),
      ], '保存固定价格')
      const rows = items.map((item) => `<tr><td>${esc(item.http_method)}</td><td><code>${esc(item.path_pattern)}</code></td><td>${esc(item.requested_model || '全部')}</td><td>${microsMoney(item.sell_micros)}</td><td>${microsMoney(item.cost_micros)}</td><td>${item.match_priority}</td><td><span class="state ${item.enabled ? 'good' : 'bad'}">${item.enabled ? '启用' : '停用'}</span></td><td class="admin-action-cell"><button class="small-button admin-edit" data-kind="fixed-price" data-item="${esc(JSON.stringify(item))}">编辑</button><button class="small-button danger-button admin-delete" data-kind="fixed-price" data-id="${esc(item.id)}">停用</button></td></tr>`)
      return `${form}${rowTable(['方法', '路径', '模型', '售价', '成本', '优先级', '状态', '操作'], rows, '尚未配置固定接口价格')}`
    }
    if (tab === 'plans') {
      const form = adminForm('plan', [
        input('code', '套餐代码', '', 'text', 'required'), input('name', '套餐名称', '', 'text', 'required'), input('priceMicros', '售价（微元）', '0', 'number', 'min="1" required'), input('quotaMicros', '额度（微元）', '0', 'number', 'min="1" required'), input('displayOrder', '排序', '100', 'number', 'min="0"'), check('active', '可购买', true),
      ], '保存套餐')
      const rows = items.map((item) => `<tr><td><strong>${esc(item.name)}</strong><small class="subline">${esc(item.code)}</small></td><td>${microsMoney(item.price_micros)}</td><td>${microsMoney(item.quota_micros)}</td><td>30 天</td><td>${item.display_order}</td><td><span class="state ${item.active && item.enabled ? 'good' : 'bad'}">${item.active && item.enabled ? '启用' : '停用'}</span></td><td class="admin-action-cell"><button class="small-button admin-edit" data-kind="plan" data-item="${esc(JSON.stringify(item))}">编辑</button><button class="small-button danger-button admin-delete" data-kind="plan" data-id="${esc(item.id)}">停用</button></td></tr>`)
      return `${form}${rowTable(['套餐', '售价', '额度', '有效期', '排序', '状态', '操作'], rows, '尚未配置套餐')}`
    }
    if (tab === 'affiliate-admin') {
      const settings = Object.fromEntries((data.settings || []).map((setting) => [setting.key, setting.value]))
      const active = settings.affiliate_enabled !== 'false'
      const rate = settings.affiliate_rate_bps || '1000'
      const form = adminForm('affiliate-settings', [input('rateBps', '返利比例（基点，1000 = 10%）', rate, 'number', 'min="0" max="10000"'), check('enabled', '开启返利', active)], '保存返利设置')
      const commissions = (data.commissions || []).map((item) => `<tr><td>${date(item.created_at)}</td><td>${esc(item.inviter_username)}</td><td>${esc(item.invitee_username)}</td><td>${microsMoney(item.paid_amount_micros)}</td><td>${(Number(item.rate_bps) / 100).toFixed(2)}%</td><td>${microsMoney(item.commission_micros)}</td></tr>`)
      const conversions = (data.conversions || []).map((item) => `<tr><td>${date(item.created_at)}</td><td>${esc(item.username)}</td><td>${microsMoney(item.amount_micros)}</td><td>${esc(item.status || '已完成')}</td></tr>`)
      return `${form}<div><p class="admin-section-title">佣金流水</p>${rowTable(['时间', '邀请人', '被邀请人', '充值', '比例', '返利'], commissions, '暂无佣金流水')}</div><div><p class="admin-section-title">兑换流水</p>${rowTable(['时间', '用户', '兑换金额', '状态'], conversions, '暂无兑换流水')}</div>`
    }
    if (tab === 'users') {
      const rows = items.map((item) => `<tr><td><strong>${esc(item.username)}</strong><small class="subline">${esc(item.id)}</small></td><td>${esc(item.role)}</td><td>${microsMoney(item.balance_micros)}</td><td>${microsMoney(item.affiliate_balance_micros)}</td><td>${date(item.last_login_at)}</td><td><span class="state ${item.status === 'active' ? 'good' : 'bad'}">${esc(item.status)}</span></td></tr>`)
      return rowTable(['用户', '角色', '钱包', '返利钱包', '最后登录', '状态'], rows)
    }
    if (tab === 'orders') {
      const rows = items.map((item) => `<tr><td>${date(item.created_at)}</td><td>${esc(item.username)}</td><td>${esc(item.kind)}</td><td>${microsMoney(item.amount_micros)}</td><td>${esc(item.payment_method)}</td><td><span class="state ${item.status === 'paid' ? 'good' : 'bad'}">${esc(item.status)}</span></td><td><code>${esc(item.order_no)}</code></td></tr>`)
      return rowTable(['时间', '用户', '类型', '金额', '方式', '状态', '订单号'], rows)
    }
    if (tab === 'admin-usage') {
      const rows = items.map((item) => `<tr><td>${date(item.created_at)}</td><td>${esc(item.username)}</td><td><code>${esc(item.request_id)}</code></td><td>${esc(item.requested_model)}</td><td>${esc(item.final_channel_name_snapshot || '—')}</td><td>${microsMoney(item.charge_micros)}</td><td>${microsMoney(item.cost_micros)} / ${microsMoney(item.profit_micros)}</td><td><button class="small-button admin-attempts" data-id="${esc(item.request_id)}">链路</button></td></tr>`)
      return `${rowTable(['时间', '用户', '请求 ID', '模型', '最终渠道', '收费', '成本 / 利润', '操作'], rows)}<div id="attempt-detail"></div>`
    }
    const rows = items.map((item) => `<tr>${Object.keys(items[0] || {}).slice(0, 8).map((key) => `<td>${esc(typeof item[key] === 'object' ? JSON.stringify(item[key]) : String(item[key] ?? ''))}</td>`).join('')}</tr>`)
    return rowTable(Object.keys(items[0] || {}).slice(0, 8), rows)
  }

  function camelField(name) {
    return name.replace(/_([a-z])/g, (_match, character) => character.toUpperCase())
  }

  function setAdminFormValue(form, name, value) {
    const field = form.elements.namedItem(name)
    if (!field) return
    if (field.type === 'checkbox') field.checked = Boolean(value)
    else field.value = value ?? ''
  }

  function ensureEditId(form, id) {
    let field = form.elements.namedItem('id')
    if (!field) {
      field = document.createElement('input')
      field.type = 'hidden'
      field.name = 'id'
      form.appendChild(field)
    }
    field.value = id
  }

  function editAdminItem(kind, item) {
    const form = $(`[data-admin-form="${kind}"]`)
    if (!form) return
    ensureEditId(form, item.id)
    if (kind === 'channel') {
      setAdminFormValue(form, 'name', item.name)
      setAdminFormValue(form, 'baseUrl', item.baseUrl)
      setAdminFormValue(form, 'apiKey', '')
      form.elements.namedItem('apiKey').required = false
      form.elements.namedItem('apiKey').placeholder = '留空则保持原上游 Key'
      setAdminFormValue(form, 'priority', item.priority)
      setAdminFormValue(form, 'timeoutMs', item.timeoutMs)
      setAdminFormValue(form, 'modelMap', JSON.stringify(item.modelMap || {}))
      setAdminFormValue(form, 'enabled', item.enabled)
    } else if (kind === 'price') {
      setAdminFormValue(form, 'modelPattern', item.model_pattern)
      setAdminFormValue(form, 'inputCostMicrosPerMillion', modelRate(item, 'input_cost'))
      setAdminFormValue(form, 'outputCostMicrosPerMillion', modelRate(item, 'output_cost'))
      setAdminFormValue(form, 'cacheCostMicrosPerMillion', modelRate(item, 'cache_cost'))
      setAdminFormValue(form, 'inputSellMicrosPerMillion', modelRate(item, 'input_sell'))
      setAdminFormValue(form, 'outputSellMicrosPerMillion', modelRate(item, 'output_sell'))
      setAdminFormValue(form, 'cacheSellMicrosPerMillion', modelRate(item, 'cache_sell'))
      setAdminFormValue(form, 'active', item.active)
    } else if (kind === 'fixed-price') {
      setAdminFormValue(form, 'httpMethod', item.http_method)
      setAdminFormValue(form, 'pathPattern', item.path_pattern)
      setAdminFormValue(form, 'requestedModel', item.requested_model)
      setAdminFormValue(form, 'costMicros', item.cost_micros)
      setAdminFormValue(form, 'sellMicros', item.sell_micros)
      setAdminFormValue(form, 'matchPriority', item.match_priority)
      setAdminFormValue(form, 'enabled', item.enabled)
    } else if (kind === 'plan') {
      setAdminFormValue(form, 'code', item.code)
      setAdminFormValue(form, 'name', item.name)
      setAdminFormValue(form, 'priceMicros', item.price_micros)
      setAdminFormValue(form, 'quotaMicros', item.quota_micros)
      setAdminFormValue(form, 'displayOrder', item.display_order)
      setAdminFormValue(form, 'active', item.active && item.enabled)
    }
    form.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function submitAdminForm(form) {
    const kind = form.dataset.adminForm
    const payload = Object.fromEntries(new FormData(form).entries())
    for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) payload[checkbox.name] = checkbox.checked
    if (kind === 'channel') {
      try { payload.modelMap = JSON.parse(payload.modelMap || '{}') } catch { throw new Error('模型映射必须是合法 JSON') }
    }
    const endpoint = {
      channel: '/api/admin/channels',
      price: '/api/admin/prices',
      'fixed-price': '/api/admin/fixed-prices',
      plan: '/api/admin/plans',
      'affiliate-settings': '/api/admin/affiliate/settings',
    }[kind]
    const method = kind === 'affiliate-settings' ? 'PATCH' : 'POST'
    const button = form.querySelector('[type="submit"]')
    setPending(button, true, '保存中…')
    try {
      await api(endpoint, { method, body: JSON.stringify(payload) })
      toast('已保存')
      await loadAdmin(kind === 'affiliate-settings' ? 'affiliate-admin' : state.adminTab)
    } finally {
      setPending(button, false)
    }
  }

  async function deleteAdminItem(kind, id, button) {
    const endpoint = {
      channel: `/api/admin/channels/${encodeURIComponent(id)}`,
      price: `/api/admin/prices/${encodeURIComponent(id)}`,
      'fixed-price': `/api/admin/fixed-prices/${encodeURIComponent(id)}`,
      plan: `/api/admin/plans/${encodeURIComponent(id)}`,
    }[kind]
    if (!endpoint || !confirm('确定停用这条配置？历史记录不会删除。')) return
    setPending(button, true, '停用中…')
    try {
      await api(endpoint, { method: 'DELETE' })
      toast('已停用')
      await loadAdmin(state.adminTab)
    } finally {
      setPending(button, false)
    }
  }

  async function loadAttempts(requestId) {
    const host = $('#attempt-detail')
    if (!host) return
    host.innerHTML = '<p class="empty">正在加载故障切换链路…</p>'
    try {
      const data = await api(`/api/admin/usage/${encodeURIComponent(requestId)}/attempts`)
      const rows = (data.items || []).map((item) => `<tr><td>${item.attempt_no || item.attempt_number}</td><td>${esc(item.channel_name_snapshot || item.current_channel_name || '—')}</td><td>${esc(item.upstream_model || '—')}</td><td>${item.status_code ?? '网络错误'}</td><td>${esc(item.outcome || item.error_type || '—')}</td><td>${item.latency_ms ?? item.duration_ms ?? 0} ms</td><td>${item.is_final ? '最终' : '已切换'}</td></tr>`)
      host.innerHTML = `<p class="admin-section-title">请求 ${esc(requestId)} 的渠道链路</p>${rowTable(['次序', '渠道', '上游模型', '状态', '结果', '耗时', '处理'], rows, '没有记录到渠道尝试')}`
    } catch (error) {
      host.innerHTML = `<p class="form-error">${esc(error.message)}</p>`
    }
  }

  async function authSubmit(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const endpoint = state.registering ? '/api/auth/register' : '/api/auth/login'
    try {
      const data = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          username: form.get('username'),
          password: form.get('password'),
          inviteCode: form.get('inviteCode'),
        }),
      })
      state.user = data.user
      $('#auth-view').classList.add('hidden')
      $('#app-view').classList.remove('hidden')
      if (data.user.role === 'admin') $('.admin-only').classList.remove('hidden')
      show('overview')
    } catch (error) {
      $('#auth-error').textContent = error.message
    }
  }

  $('#auth-form').addEventListener('submit', authSubmit)
  $('#auth-toggle').addEventListener('click', () => {
    state.registering = !state.registering
    $('#invite-field').classList.toggle('hidden', !state.registering)
    $('#auth-submit').textContent = state.registering ? '注册并登录' : '登录'
    $('#auth-toggle').textContent = state.registering ? '已有账号？登录' : '没有账号？注册'
    $('#auth-error').textContent = ''
  })
  $('#logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' })
    location.reload()
  })
  $$('#main-nav .nav-item').forEach((node) => node.addEventListener('click', () => show(node.dataset.view)))
  $$('[data-go]').forEach((node) => node.addEventListener('click', () => show(node.dataset.go)))
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]')
    if (button) copy(button.dataset.copy)
  })
  $('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'))
  $('#usage-filters').addEventListener('submit', (event) => {
    event.preventDefault()
    loadUsage(true)
  })
  $('#usage-more').addEventListener('click', () => loadUsage(false))
  $('#new-key').addEventListener('click', async () => {
    const name = prompt('Key 名称', '默认 Key')
    if (!name) return
    try {
      const data = await api('/api/me/keys', { method: 'POST', body: JSON.stringify({ name }) })
      const copied = await copyText(data.key.key).then(() => true).catch(() => false)
      alert(`${copied ? '完整 Key 已复制到剪贴板' : '请立即复制完整 Key'}：\n\n${data.key.key}`)
      loadKeys()
    } catch (error) {
      toast(error.message, true)
    }
  })
  $('#keys-table').addEventListener('click', async (event) => {
    const importButton = event.target.closest('.import-key')
    if (importButton) {
      await importCcswitch(importButton.dataset.id, importButton)
      return
    }
    const revokeButton = event.target.closest('.revoke-key')
    if (!revokeButton || !confirm('确定撤销此 Key？撤销后无法恢复。')) return
    setPending(revokeButton, true, '撤销中…')
    try {
      await api(`/api/me/keys/${encodeURIComponent(revokeButton.dataset.id)}`, { method: 'DELETE' })
      toast('已撤销')
      loadKeys()
    } catch (error) {
      toast(error.message, true)
      setPending(revokeButton, false)
    }
  })
  $('#topup-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = event.currentTarget.querySelector('[type="submit"]')
    const form = new FormData(event.currentTarget)
    setPending(button, true, '正在创建…')
    try {
      const data = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'wallet_topup',
          amountMicros: yuanToMicros(form.get('amount')),
          paymentMethod: form.get('paymentMethod'),
        }),
      })
      renderPayment(data)
    } catch (error) {
      toast(error.message, true)
    } finally {
      setPending(button, false)
    }
  })
  $('#plans').addEventListener('click', async (event) => {
    const button = event.target.closest('.buy-plan')
    if (!button) return
    setPending(button, true, '正在创建…')
    try {
      const data = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'subscription',
          planId: button.dataset.id,
          amountMicros: button.dataset.amount,
          paymentMethod: $('#plan-payment-method').value,
        }),
      })
      renderPayment(data)
    } catch (error) {
      toast(error.message, true)
    } finally {
      setPending(button, false)
    }
  })
  $('#affiliate-convert').addEventListener('click', async (event) => {
    const button = event.currentTarget
    setPending(button, true, '兑换中…')
    try {
      await api('/api/me/affiliate/convert', { method: 'POST', body: JSON.stringify({}) })
      toast('返利已兑换到 API 钱包')
      await Promise.all([loadAffiliate(), loadOverview()])
    } catch (error) {
      toast(error.message, true)
    } finally {
      setPending(button, false)
    }
  })
  $$('.admin-tabs .tab').forEach((node) => node.addEventListener('click', () => loadAdmin(node.dataset.adminTab)))
  $('#admin-content').addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-admin-form]')
    if (!form) return
    event.preventDefault()
    try {
      await submitAdminForm(form)
    } catch (error) {
      toast(error.message, true)
    }
  })
  $('#admin-content').addEventListener('click', async (event) => {
    const edit = event.target.closest('.admin-edit')
    if (edit) {
      try {
        editAdminItem(edit.dataset.kind, JSON.parse(edit.dataset.item))
      } catch {
        toast('无法读取这条配置', true)
      }
      return
    }
    const remove = event.target.closest('.admin-delete')
    if (remove) {
      try {
        await deleteAdminItem(remove.dataset.kind, remove.dataset.id, remove)
      } catch (error) {
        toast(error.message, true)
      }
      return
    }
    const attempts = event.target.closest('.admin-attempts')
    if (attempts) await loadAttempts(attempts.dataset.id)
  })

  applyInviteFromUrl()
  ;(async () => {
    try {
      const data = await api('/api/auth/me')
      state.user = data.user
      $('#auth-view').classList.add('hidden')
      $('#app-view').classList.remove('hidden')
      $('#user-label').textContent = data.user.username
      if (data.user.role === 'admin') $('.admin-only').classList.remove('hidden')
      show('overview')
    } catch {
      // Keep the login screen visible.
    }
  })()
})()
