import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
import type { AppConfig } from '../config.js'

export type DbClient = PoolClient
export type DatabaseClient = PoolClient

export type DatabasePoolOptions = {
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
  applicationName?: string
}

export type TransactionOptions = {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'
  readOnly?: boolean
}

export type MigrationOptions = {
  schemaPath?: string
  logger?: Pick<Console, 'info'>
}

export type MigrationResult = { name: string; checksum: string; applied: boolean }

const migrationName = 'relay-station-schema'
const isolationSql: Record<NonNullable<TransactionOptions['isolationLevel']>, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
}

export function createDatabasePool(databaseUrl: string, options: DatabasePoolOptions = {}): Pool {
  if (!databaseUrl) throw new Error('databaseUrl is required')
  const poolConfig: PoolConfig = {
    connectionString: databaseUrl,
    max: options.max ?? 20,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    application_name: options.applicationName ?? 'relay-station',
  }
  return new Pool(poolConfig)
}

/** Compatibility wrapper used by relay-station services. */
export class Database {
  readonly pool: Pool

  constructor(config: AppConfig | string, options: DatabasePoolOptions = {}) {
    const databaseUrl = typeof config === 'string' ? config : config.databaseUrl
    const envMax = Number(process.env.RELAY_DB_POOL_MAX || process.env.DB_POOL_MAX || '')
    this.pool = createDatabasePool(databaseUrl, {
      ...options,
      max: options.max ?? (Number.isInteger(envMax) && envMax > 0 ? envMax : undefined),
    })
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, values)
    return result.rows
  }

  async one<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, values)
    return rows[0] ?? null
  }

  async tx<T>(fn: (client: DbClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return withTransaction(this.pool, fn, options)
  }

  async migrate(options: MigrationOptions = {}): Promise<MigrationResult> {
    return runMigrations(this.pool, options)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export async function withTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect()
  const level = options.isolationLevel ?? 'read committed'
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationSql[level]}${options.readOnly ? ' READ ONLY' : ''}`)
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  } finally {
    client.release()
  }
}

export function withSerializableTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, action, { isolationLevel: 'serializable' })
}

export async function query<T extends QueryResultRow = QueryResultRow>(client: DbClient | Database, text: string, values: unknown[] = []): Promise<T[]> {
  // `Database.query` and `PoolClient.query` have different generic overloads
  // in pg's type declarations.  Normalize the small common surface here so
  // callers can use the helper with either a transaction client or the pool.
  const run = (client as { query: (sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }).query
  const result = await run.call(client, text, values)
  return result.rows
}

export async function one<T extends QueryResultRow = QueryResultRow>(client: DbClient | Database, text: string, values: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(client, text, values)
  return rows[0] ?? null
}

async function readSchema(schemaPath?: string): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    schemaPath,
    resolve(process.cwd(), 'src/db/schema.sql'),
    resolve(process.cwd(), 'dist/db/schema.sql'),
    resolve(moduleDirectory, 'schema.sql'),
  ].filter((item): item is string => Boolean(item))
  const attempted = new Set<string>()
  for (const candidate of candidates) {
    const absolutePath = resolve(candidate)
    if (attempted.has(absolutePath)) continue
    attempted.add(absolutePath)
    try {
      return await readFile(absolutePath, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) continue
      throw error
    }
  }
  throw new Error(`Unable to locate relay station schema.sql. Checked: ${[...attempted].join(', ')}`)
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Apply the schema while serializing concurrent API/worker startup. */
export async function runMigrations(pool: Pool, options: MigrationOptions = {}): Promise<MigrationResult> {
  const schema = await readSchema(options.schemaPath)
  const checksum = createHash('sha256').update(schema).digest('hex')
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [migrationName])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [migrationName])
    if (existing.rowCount === 1 && existing.rows[0]?.checksum === checksum) {
      return { name: migrationName, checksum, applied: false }
    }
    await client.query(schema)
    await client.query(
      `INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, now())
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = EXCLUDED.applied_at`,
      [migrationName, checksum],
    )
    options.logger?.info(`Applied ${migrationName}`)
    return { name: migrationName, checksum, applied: true }
  })
}
