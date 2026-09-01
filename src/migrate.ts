import { loadConfig } from './config.js'
import { Database } from './db/index.js'

const config = loadConfig()
const db = new Database(config)
try {
  await db.migrate()
  console.log('relay-station migrations complete')
} finally {
  await db.close()
}

