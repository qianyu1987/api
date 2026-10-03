import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

describe('video channel administration UI', () => {
  test('keeps quota reset inside a disclosure while preserving the audited reason prompt', () => {
    const actions = appSource.match(/<div class="row-actions video-key-actions">([\s\S]*?)<\/div><\/td><\/tr>/)?.[1]
    expect(actions).toContain('<details class="video-key-more-actions"><summary>更多</summary>')
    expect(actions?.split('<details')[0]).not.toContain('data-video-key-action="reset"')
    expect(actions).toContain('data-video-key-action="reset"')
    expect(appSource).toContain("resetReason.trim().length < 4")
    expect(appSource).toContain("请输入重置原因（至少 4 个字符）")
  })
})
