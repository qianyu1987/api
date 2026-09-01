import { connect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { Database, one } from '../db/index.js'
import type { AppConfig } from '../config.js'
import { decryptSecret, encryptSecret } from '../lib/crypto.js'

type EmailPayload = { subject: string; text: string }

function cleanHeader(value: string): string {
  return String(value || '').replace(/[\r\n]/g, ' ').trim()
}

function encodedHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(cleanHeader(value), 'utf8').toString('base64')}?=`
}

function normalizedEmail(value: string): string {
  const email = String(value || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式无效')
  return email
}

function smtpConfigured(config: AppConfig): boolean {
  const smtp = config.smtp
  return Boolean(smtp.host && smtp.username && smtp.password && smtp.from)
}

async function deliverSmtp(config: AppConfig, recipient: string, payload: EmailPayload): Promise<void> {
  if (!smtpConfigured(config)) throw Object.assign(new Error('邮件服务尚未配置'), { statusCode: 503 })
  const smtp = config.smtp
  if (!smtp.secure) throw new Error('SMTP 必须使用 TLS 连接')
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const value = connect({ host: smtp.host, port: smtp.port, servername: smtp.host, rejectUnauthorized: true })
    const timeout = setTimeout(() => { value.destroy(); reject(new Error('SMTP 连接超时')) }, 10_000)
    value.once('secureConnect', () => { clearTimeout(timeout); resolve(value) })
    value.once('error', (error) => { clearTimeout(timeout); reject(error) })
  })
  socket.setEncoding('utf8')
  let pending = ''
  let socketError: Error | null = null
  socket.on('data', (chunk) => { pending += String(chunk) })
  socket.on('error', (error: Error) => { socketError = error })
  const readResponse = async (): Promise<number> => {
    let code = 0
    for (;;) {
      const index = pending.indexOf('\n')
      if (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        const match = /^(\d{3})([ -])/.exec(line)
        if (!match) continue
        code = Number(match[1])
        if (match[2] === ' ') return code
        continue
      }
      if (socketError) throw socketError
      await new Promise<void>((resolve, reject) => {
        const onData = () => cleanup(resolve)
        const onError = (error: Error) => cleanup(() => reject(error))
        const cleanup = (done: () => void) => {
          socket.off('data', onData)
          socket.off('error', onError)
          done()
        }
        socket.once('data', onData)
        socket.once('error', onError)
      })
    }
  }
  const command = async (line: string, expected: number | number[]) => {
    socket.write(`${line}\r\n`)
    const code = await readResponse()
    const allowed = Array.isArray(expected) ? expected : [expected]
    if (!allowed.includes(code)) throw new Error(`SMTP 响应异常 (${code || 'unknown'})`)
  }
  try {
    if (await readResponse() !== 220) throw new Error('SMTP 服务不可用')
    await command('EHLO api.hhtc.top', 250)
    await command('AUTH LOGIN', 334)
    await command(Buffer.from(smtp.username, 'utf8').toString('base64'), 334)
    await command(Buffer.from(smtp.password, 'utf8').toString('base64'), 235)
    const from = normalizedEmail(smtp.from)
    await command(`MAIL FROM:<${from}>`, 250)
    await command(`RCPT TO:<${normalizedEmail(recipient)}>`, [250, 251])
    await command('DATA', 354)
    const body = String(payload.text || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    const source = [
      `From: ${encodedHeader(smtp.fromName)} <${from}>`,
      `To: <${normalizedEmail(recipient)}>`,
      `Subject: ${encodedHeader(payload.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '.',
    ].join('\r\n')
    socket.write(`${source}\r\n`)
    if (await readResponse() !== 250) throw new Error('SMTP 投递失败')
    await command('QUIT', 221)
  } finally {
    socket.destroy()
  }
}

export class MailService {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  get configured(): boolean { return smtpConfigured(this.config) }

  get status(): { configured: boolean; host: string | null; port: number | null; secure: boolean; from: string | null } {
    return {
      configured: this.configured,
      host: this.config.smtp.host || null,
      port: this.config.smtp.host ? this.config.smtp.port : null,
      secure: this.config.smtp.secure,
      from: this.config.smtp.from || null,
    }
  }

  async sendRegistrationCode(email: string, code: string): Promise<void> {
    await deliverSmtp(this.config, email, {
      subject: 'GPT TOKEN 注册验证码',
      text: `你的注册验证码是：${code}\n\n验证码 10 分钟内有效，请勿向任何人泄露。`,
    })
  }

  async queueLowBalance(userId: string): Promise<void> {
    if (!this.configured) return
    const user = await this.db.one<any>('SELECT email FROM users WHERE id = $1 AND email_verified_at IS NOT NULL', [userId])
    if (!user?.email) return
    const day = new Date().toISOString().slice(0, 10)
    const payload = encryptSecret(JSON.stringify({
      subject: 'GPT TOKEN 余额不足提醒',
      text: '你的 API 可用余额不足，新的付费请求将无法转发。请登录 GPT TOKEN 控制台充值后继续使用。',
    } satisfies EmailPayload), this.config.channelEncryptionKey)
    await this.db.query(
      `INSERT INTO email_jobs(kind,recipient,payload_encrypted,dedupe_key)
       VALUES('low_balance',$1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING`,
      [String(user.email).toLowerCase(), payload, `low-balance:${userId}:${day}`],
    )
  }

  async deliverQueued(limit = 10): Promise<number> {
    if (!this.configured) return 0
    let delivered = 0
    for (let index = 0; index < Math.max(1, Math.min(50, limit)); index += 1) {
      const job = await this.db.tx(async (client) => {
        const row = await one<any>(client,
          `SELECT * FROM email_jobs
           WHERE status = 'queued' AND available_at <= now()
           ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
        if (!row) return null
        await client.query(
          `UPDATE email_jobs SET status='processing',attempts=attempts+1,updated_at=now() WHERE id=$1`,
          [row.id],
        )
        return { ...row, attempts: Number(row.attempts) + 1 }
      })
      if (!job) break
      try {
        const payload = JSON.parse(decryptSecret(String(job.payload_encrypted), this.config.channelEncryptionKey)) as EmailPayload
        await deliverSmtp(this.config, String(job.recipient), payload)
        await this.db.query(`UPDATE email_jobs SET status='sent',sent_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`, [job.id])
        delivered += 1
      } catch (error) {
        const attempts = Number(job.attempts || 1)
        const retry = attempts < 5
        const seconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1))
        await this.db.query(
          `UPDATE email_jobs
           SET status=$2,available_at=now() + ($3 || ' seconds')::interval,
               last_error=$4,updated_at=now()
           WHERE id=$1`,
          [job.id, retry ? 'queued' : 'failed', String(seconds), String((error as Error).message || 'delivery_failed').slice(0, 256)],
        )
      }
    }
    return delivered
  }
}
