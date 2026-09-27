import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8')

describe('night discount account UI', () => {
  test('ships a read-only customer card with the fixed Beijing window and safe loading state', () => {
    const card = html.slice(html.indexOf('<section id="night-discount-card"'), html.indexOf('</section>', html.indexOf('<section id="night-discount-card"')))
    expect(card).toContain('data-night-discount-status="unavailable"')
    expect(card).toContain('北京时间 00:00-04:00')
    expect(card).toContain('当前实际折扣')
    expect(card).toContain('配置折扣')
    expect(card).toContain('当前账号最终折扣')
    expect(card).toContain('状态倒计时 —')
    expect(card).toContain('role="timer"')
    expect(card).not.toContain('aria-live="polite"')
    expect(card).not.toMatch(/<input|<button|<select/)
  })

  test('renders only server-provided discounts and has no invented default percentage', () => {
    expect(source).toContain('normalizeNightDiscount(raw)')
    expect(source).toContain('data.configuredDiscountBps ?? data.discountBps')
    expect(source).toContain('data.appliedDiscountBps ?? data.currentDiscountBps')
    expect(source).toContain('current?.effectiveTokenDiscountBps ?? discountBps(overviewEffectiveDiscountBps)')
    expect(source).toContain("服务端尚未返回完整配置，当前不会推测折扣。")
    expect(source).not.toMatch(/nightDiscount[^\n]*(?:=|\?\?)\s*(?:1000|1500|2000|2500|3000)\b/)
  })

  test('distinguishes active, waiting, disabled and unavailable states responsively', () => {
    expect(source).toContain("unavailable: '暂不可用'")
    expect(source).toContain("disabled: '当前关闭'")
    expect(source).toContain("waiting: '等待时段'")
    expect(source).toContain("active: '正在生效'")
    expect(styles).toContain('[data-night-discount-status="active"]')
    expect(styles).toContain('@media (max-width: 980px)')
    expect(styles).toContain('@media (max-width: 600px)')
    expect(styles).toContain('.night-discount-details { grid-template-columns: 1fr; }')
  })

  test('refreshes overview once at a server-declared transition boundary', () => {
    const countdown = source.slice(source.indexOf('  function updateNightDiscountCountdown()'), source.indexOf('  function renderNightDiscount('))
    expect(countdown).toContain('clearNightDiscountTimer()')
    expect(countdown).toContain('state.nightDiscountTransitionRequested === current.nextTransitionAt')
    expect(countdown).toContain('state.nightDiscountTransitionRequested = current.nextTransitionAt')
    expect(countdown).toContain('loadOverview()')
    expect(countdown).not.toContain("current.active =")
  })
})

describe('night discount administration UI', () => {
  test('keeps controls in the admin-rendered settings surface and submits server-owned fields', () => {
    expect(source).toContain("form('night-discount-settings'")
    expect(source).toContain("check('enabled', '启用每日 00:00-04:00 深夜折扣'")
    expect(source).toContain("payload.discountBps = Math.round(percent * 100)")
    expect(source).toContain("'night-discount-settings': '/api/admin/settings/night-discount'")
    expect(source).toContain("kind === 'night-discount-settings' ? 'PATCH'")
    expect(html).not.toContain('data-admin-form="night-discount-settings"')
  })

  test('adds gpt-6-sol as a distinct fifth comparison model', () => {
    expect(html).toContain('五模型价格对比')
    expect(source).toContain("['gpt-6-sol', 'Sol 6']")
    expect(source.indexOf("['gpt-6-astra', 'Astra']")).toBeLessThan(source.indexOf("['gpt-6-sol', 'Sol 6']"))
    expect(source.indexOf("['gpt-6-sol', 'Sol 6']")).toBeLessThan(source.indexOf("['gpt-5.6-sol', 'Sol']"))
  })
})
