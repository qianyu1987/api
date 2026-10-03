import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

describe('video channel administration UI', () => {
  test('separates local usage from the unsynchronized upstream quota', () => {
    expect(appSource).toContain('本站可分配')
    expect(appSource).toContain('本站已接单 ')
    expect(appSource).toContain('上游额度：未同步')
    expect(appSource).toContain('核对本站用量不会重置上游额度')
  })
  test('offers ledger reconciliation instead of replenishing provider quota', () => {
    const actions = appSource.match(/<div class="row-actions video-key-actions">([\s\S]*?)<\/div><\/td><\/tr>/)?.[1]
    expect(actions).toContain('data-video-key-action="reconcile"')
    expect(actions).not.toContain('data-video-key-action="reset"')
    expect(appSource).toContain("'/reconcile-usage'")
    expect(appSource).not.toContain('今日额度已重置')
  })
})
