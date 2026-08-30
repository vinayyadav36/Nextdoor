import { Worker } from 'node:worker_threads'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { env } from '../config/env'

export interface StatementAdapter {
  all(...params: unknown[]): any[]
  get(...params: unknown[]): any
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | string | bigint }
}

export interface DatabaseAdapter {
  prepare(query: string): StatementAdapter
  exec(query: string): void
  transaction<T>(fn: () => T): () => T
  pragma?(query: string): unknown
  close?(): void
}

let dbInstance: DatabaseAdapter | null = null
let pgWorker: Worker | null = null
const sab = new SharedArrayBuffer(8 * 1024 * 1024) // 8MB communication buffer
const int32 = new Int32Array(sab)
const uint8 = new Uint8Array(sab)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const pgWorkerCode = `
const { workerData, parentPort } = require('node:worker_threads');
const { Client } = require('pg');

const { connectionString, sab } = workerData;
const int32 = new Int32Array(sab);
const uint8 = new Uint8Array(sab);

const client = new Client({ connectionString });

async function run() {
  await client.connect();

  // Tell the parent thread that we are ready
  parentPort?.postMessage({ type: 'ready' });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  while (true) {
    // Wait until state (int32[0]) becomes 1 (Query requested)
    Atomics.wait(int32, 0, 0);

    if (Atomics.load(int32, 0) !== 1) {
      continue;
    }

    // Read input query and parameters
    const length = int32[1];
    const queryDataString = decoder.decode(uint8.subarray(8, 8 + length));
    const { query, params } = JSON.parse(queryDataString);

    // Rewrite query placeholders from ? to $1, $2 for PostgreSQL
    let index = 1;
    let pgSql = query.replace(/\\?/g, () => \`$\${index++}\`);

    // Map SQLite-specific dialects to PostgreSQL
    pgSql = pgSql
      .replace(/INSERT OR IGNORE INTO user_saved_places/gi, 'INSERT INTO user_saved_places')
      .replace(/INSERT OR IGNORE INTO users/gi, 'INSERT INTO users')
      .replace(/INSERT OR IGNORE INTO emergencies/gi, 'INSERT INTO emergencies')
      .replace(/INSERT OR IGNORE INTO buildings/gi, 'INSERT INTO buildings')
      .replace(/datetime\\('now'\\)/gi, 'CURRENT_TIMESTAMP');

    // If we removed OR IGNORE, append ON CONFLICT clause
    if (query.toUpperCase().includes('INSERT OR IGNORE INTO USER_SAVED_PLACES')) {
      pgSql += ' ON CONFLICT (user_id, business_id) DO NOTHING';
    } else if (query.toUpperCase().includes('INSERT OR IGNORE INTO USERS')) {
      pgSql += ' ON CONFLICT (email) DO NOTHING';
    } else if (query.toUpperCase().includes('INSERT OR IGNORE INTO EMERGENCIES')) {
      pgSql += ' ON CONFLICT (id) DO NOTHING';
    } else if (query.toUpperCase().includes('INSERT OR IGNORE INTO BUILDINGS')) {
      pgSql += ' ON CONFLICT (id) DO NOTHING';
    }

    try {
      const res = await client.query(pgSql, params);
      const responseObj = {
        rows: res.rows,
        rowCount: res.rowCount,
        changes: res.rowCount,
      };
      const responseBytes = encoder.encode(JSON.stringify(responseObj));

      // Write results to SharedArrayBuffer
      uint8.set(responseBytes, 8);
      int32[1] = responseBytes.length;

      // Set state to 2 (Success) and notify main thread
      Atomics.store(int32, 0, 2);
      Atomics.notify(int32, 0, 1);
    } catch (err) {
      const errorBytes = encoder.encode(JSON.stringify({ error: err.message }));

      // Write error to SharedArrayBuffer
      uint8.set(errorBytes, 8);
      int32[1] = errorBytes.length;

      // Set state to 3 (Error) and notify main thread
      Atomics.store(int32, 0, 3);
      Atomics.notify(int32, 0, 1);
    }
  }
}

run().catch((err) => {
  console.error('[pgWorker] Fatal crash:', err);
  process.exit(1);
});
`;

function executePgQuerySync(query: string, params: unknown[] = []): any {
  if (!pgWorker) {
    pgWorker = new Worker(pgWorkerCode, {
      eval: true,
      workerData: { connectionString: process.env.DATABASE_URL, sab },
    })

    pgWorker.unref()
  }

  // Write query data to SharedArrayBuffer
  const queryBytes = encoder.encode(JSON.stringify({ query, params }))
  uint8.set(queryBytes, 8)
  int32[1] = queryBytes.length

  // Set state to 1 (Query requested) and notify worker
  Atomics.store(int32, 0, 1)
  Atomics.notify(int32, 0, 1)

  // Block synchronously until worker finishes (state changes from 1 to 2 or 3)
  Atomics.wait(int32, 0, 1)

  const state = Atomics.load(int32, 0)
  const responseLen = int32[1]
  const responseBytes = uint8.subarray(8, 8 + responseLen)
  const responseString = decoder.decode(responseBytes)

  // Set state back to 0 (Idle)
  Atomics.store(int32, 0, 0)

  const res = JSON.parse(responseString)
  if (state === 3) {
    throw new Error(res.error || 'PostgreSQL execution error')
  }

  return res
}

export function getDatabase(): DatabaseAdapter {
  if (dbInstance) return dbInstance

  const pgUrl = process.env.DATABASE_URL
  if (pgUrl) {
    console.log('[db] Initializing dynamic PostgreSQL client adapter')
    dbInstance = {
      prepare(query: string) {
        return {
          all(...params: unknown[]) {
            const res = executePgQuerySync(query, params)
            return res.rows
          },
          get(...params: unknown[]) {
            const res = executePgQuerySync(query, params)
            return res.rows[0] || null
          },
          run(...params: unknown[]) {
            const res = executePgQuerySync(query, params)
            return { changes: res.changes }
          },
        }
      },
      exec(query: string) {
        executePgQuerySync(query, [])
      },
      transaction<T>(fn: () => T) {
        return () => {
          executePgQuerySync('BEGIN', [])
          try {
            const res = fn()
            executePgQuerySync('COMMIT', [])
            return res
          } catch (err) {
            executePgQuerySync('ROLLBACK', [])
            throw err
          }
        }
      },
      pragma(query: string) {
        if (query.startsWith('table_info(')) {
          const tableName = query.match(/table_info\((.+)\)/)?.[1]
          if (tableName) {
            const sql = `
              SELECT column_name as name 
              FROM information_schema.columns 
              WHERE table_name = $1
            `
            const res = executePgQuerySync(sql, [tableName.toLowerCase()])
            return res.rows
          }
        }
        return []
      },
      close() {
        if (pgWorker) {
          pgWorker.terminate()
          pgWorker = null
        }
        dbInstance = null
      },
    }
  } else {
    console.log('[db] Initializing fallback local SQLite engine')
    const dbPath = process.env.VERCEL === '1'
      ? '/tmp/app.db'
      : resolve(__dirname, '..', '..', '..', env.databasePath || './data/app.db')
    const dbDir = dirname(dbPath)

    if (process.env.VERCEL !== '1' && !existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    let sqliteDb: any
    try {
      const Database = require('better-sqlite3')
      sqliteDb = new Database(dbPath)
    } catch (e: any) {
      console.error('[db] Failed to load local SQLite engine (better-sqlite3). If running on serverless, please ensure DATABASE_URL is configured to use PostgreSQL instead.', e)
      throw new Error(`Failed to load SQLite database engine: ${e.message}`)
    }
    sqliteDb.pragma('journal_mode = WAL')
    sqliteDb.pragma('foreign_keys = ON')

    dbInstance = {
      prepare(query: string) {
        const stmt = sqliteDb.prepare(query)
        return {
          all(...params: unknown[]) {
            return stmt.all(...params)
          },
          get(...params: unknown[]) {
            return stmt.get(...params)
          },
          run(...params: unknown[]) {
            return stmt.run(...params)
          },
        }
      },
      exec(query: string) {
        sqliteDb.exec(query)
      },
      transaction<T>(fn: () => T) {
        const trans = sqliteDb.transaction(fn)
        return () => trans()
      },
      pragma(query: string) {
        return sqliteDb.pragma(query)
      },
      close() {
        sqliteDb.close()
        dbInstance = null
      },
    }
  }

  return dbInstance!
}

export function closeDatabase(): void {
  if (dbInstance && dbInstance.close) {
    dbInstance.close()
  }
  dbInstance = null
}

function checkTableExists(tableName: string, isPg: boolean, db: DatabaseAdapter): boolean {
  if (isPg) {
    const res = db.prepare(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1"
    ).get(tableName.toLowerCase())
    return !!res
  } else {
    const res = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(tableName)
    return !!res
  }
}

function checkColumnExists(tableName: string, columnName: string, isPg: boolean, db: DatabaseAdapter): boolean {
  if (isPg) {
    const res = db.prepare(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2"
    ).get(tableName.toLowerCase(), columnName.toLowerCase())
    return !!res
  } else {
    const cols = db.pragma!(`table_info(${tableName})`) as any[]
    return cols.some((c) => c.name === columnName)
  }
}

export function runMigrations(): void {
  const database = getDatabase()
  const isPg = !!process.env.DATABASE_URL

  // 1. Run migrations for ALTERing tables if they exist
  try {
    if (checkTableExists('circles', isPg, database)) {
      if (!checkColumnExists('circles', 'pin', isPg, database)) {
        database.exec('ALTER TABLE circles ADD COLUMN pin TEXT;')
        console.log('[db migration] Added pin column to circles')
      }
    }
  } catch (e) {
    console.error('Migration error circles pin:', e)
  }

  try {
    if (checkTableExists('channels', isPg, database)) {
      if (!checkColumnExists('channels', 'pin', isPg, database)) {
        database.exec('ALTER TABLE channels ADD COLUMN pin TEXT;')
        console.log('[db migration] Added pin column to channels')
      }
    }
  } catch (e) {
    console.error('Migration error channels pin:', e)
  }

  try {
    if (!isPg && checkTableExists('circle_members', isPg, database)) {
      const currentOwnerCount = database.prepare("SELECT COUNT(*) as count FROM circle_members WHERE role = 'owner'").get() as any
      const currentAdminCount = database.prepare("SELECT COUNT(*) as count FROM circle_members WHERE role = 'admin'").get() as any
      if ((currentOwnerCount && currentOwnerCount.count > 0) || (currentAdminCount && currentAdminCount.count > 0)) {
        console.log('[db migration] Migrating circle_members role schema...')
        database.transaction(() => {
          database.exec(`
            CREATE TABLE IF NOT EXISTS circle_members_new (
              id TEXT PRIMARY KEY,
              circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
              user_id TEXT NOT NULL REFERENCES users(id),
              role TEXT DEFAULT 'member' CHECK (role IN ('member','elder','co_admin','admin')),
              joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(circle_id, user_id)
            );
          `)
          database.exec(`
            INSERT OR IGNORE INTO circle_members_new (id, circle_id, user_id, role, joined_at)
            SELECT id, circle_id, user_id,
                   CASE WHEN role = 'owner' THEN 'admin'
                        WHEN role = 'admin' THEN 'co_admin'
                        ELSE 'member' END,
                   joined_at
            FROM circle_members;
          `)
          database.exec('DROP TABLE circle_members;')
          database.exec('ALTER TABLE circle_members_new RENAME TO circle_members;')
        })()
        console.log('[db migration] Recreated circle_members with new roles check constraint')
      }
    }
  } catch (e) {
    console.error('Migration error circle_members roles:', e)
  }

  try {
    if (checkTableExists('businesses', isPg, database)) {
      if (!checkColumnExists('businesses', 'priority', isPg, database)) {
        database.exec('ALTER TABLE businesses ADD COLUMN priority INTEGER DEFAULT 0;')
        console.log('[db migration] Added priority column to businesses')
      }
    }
  } catch (e) {
    console.error('Migration error businesses priority:', e)
  }

  try {
    if (checkTableExists('messages', isPg, database)) {
      if (!checkColumnExists('messages', 'expires_at', isPg, database)) {
        const dType = isPg ? 'TIMESTAMP' : 'DATETIME'
        database.exec(`ALTER TABLE messages ADD COLUMN expires_at ${dType};`)
        console.log('[db migration] Added expires_at column to messages')
      }
    }
  } catch (e) {
    console.error('Migration error messages expires_at:', e)
  }

  try {
    if (checkTableExists('users', isPg, database)) {
      const realType = isPg ? 'DOUBLE PRECISION' : 'REAL'
      if (!checkColumnExists('users', 'last_seen_at', isPg, database)) {
        const dType = isPg ? 'TIMESTAMP' : 'DATETIME'
        database.exec(`ALTER TABLE users ADD COLUMN last_seen_at ${dType};`)
        console.log('[db migration] Added last_seen_at column to users')
      }
      if (!checkColumnExists('users', 'last_lat', isPg, database)) {
        database.exec(`ALTER TABLE users ADD COLUMN last_lat ${realType};`)
        console.log('[db migration] Added last_lat column to users')
      }
      if (!checkColumnExists('users', 'last_lng', isPg, database)) {
        database.exec(`ALTER TABLE users ADD COLUMN last_lng ${realType};`)
        console.log('[db migration] Added last_lng column to users')
      }
    }
  } catch (e) {
    console.error('Migration error users location columns:', e)
  }

  const schema = getSchema(isPg)
  for (const statement of schema) {
    database.exec(statement)
  }

  // Ensure Guest User exists to satisfy foreign key constraints for unauthenticated clients
  const insertGuestSql = isPg
    ? `INSERT INTO users (id, email, name, password_hash, role, points, created_at, updated_at)
       VALUES ('000000000000000000000000', 'guest@nextdoor.local', 'Guest User', 'guest_placeholder', 'user', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO NOTHING`
    : `INSERT OR IGNORE INTO users (id, email, name, password_hash, role, points, created_at, updated_at)
       VALUES ('000000000000000000000000', 'guest@nextdoor.local', 'Guest User', 'guest_placeholder', 'user', 0, datetime('now'), datetime('now'))`
  database.exec(insertGuestSql)

  // Ensure Super Admin exists if configured in env
  if (env.superAdminEmail) {
    const emailNorm = env.superAdminEmail.toLowerCase().trim()
    const insertAdminSql = isPg
      ? `INSERT INTO users (id, email, name, password_hash, role, points, created_at, updated_at)
         VALUES ('super_admin_id', $1, 'Super Admin', '', 'admin', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (email) DO NOTHING`
      : `INSERT OR IGNORE INTO users (id, email, name, password_hash, role, points, created_at, updated_at)
         VALUES ('super_admin_id', ?, 'Super Admin', '', 'admin', 0, datetime('now'), datetime('now'))`

    database.prepare(insertAdminSql).run(emailNorm)
    console.log(`[db init] Verified/created Super Admin user with email: ${emailNorm}`)

    // Ensure Super Admin is member of all existing circles
    try {
      const circlesList = database.prepare('SELECT id FROM circles').all() as { id: string }[]
      for (const c of circlesList) {
        const checkSql = 'SELECT COUNT(*) as count FROM circle_members WHERE circle_id = ? AND user_id = ?'
        const row = database.prepare(checkSql).get(c.id, 'super_admin_id') as any
        const count = row?.count ?? row?.countVal ?? 0
        if (Number(count) === 0) {
          const insertMemSql = `
            INSERT INTO circle_members (id, circle_id, user_id, role, joined_at)
            VALUES (?, ?, ?, 'admin', ${isPg ? 'CURRENT_TIMESTAMP' : "datetime('now')"})
          `
          const memId = Math.random().toString(36).substring(2, 15)
          database.prepare(insertMemSql).run(memId, c.id, 'super_admin_id')
        }
      }
      console.log('[db init] Super Admin verified as admin in all circles')
    } catch (e) {
      console.error('Error verifying Super Admin in existing circles:', e)
    }
  }

  // Ensure default emergency contacts exist
  const countEmergenciesSql = 'SELECT COUNT(*) as count FROM emergencies'
  const emergencyCount = database.prepare(countEmergenciesSql).get() as any
  const countVal = emergencyCount?.count ?? emergencyCount?.countVal ?? 0

  if (Number(countVal) === 0) {
    const emergenciesList = [
      { name: 'Police Helpline', type: 'Police', phone: '112', address: 'Central Police Station, Railway Chowk, Rewari', lat: 28.1975, lng: 76.6210 },
      { name: 'Fire Station Rewari', type: 'Fire', phone: '101', address: 'Fire Station, Jhajjar Road, Rewari', lat: 28.1990, lng: 76.6275 },
      { name: 'Ambulance & Trauma Center', type: 'Ambulance', phone: '102', address: 'Civil Hospital Trauma Center, Rewari', lat: 28.1889, lng: 76.6340 },
      { name: 'Women Helpline', type: 'Women Help', phone: '1091', address: 'Women Police Station, Rewari', lat: 28.1960, lng: 76.6180 },
      { name: 'NHAI Expressway Helpline', type: 'Highway Help', phone: '1033', address: 'NH-48 Corridor, Rewari Segment', lat: 28.2185, lng: 76.7780 },
    ]
    for (const e of emergenciesList) {
      const id = Math.random().toString(36).substring(2, 15)
      const insertEmergencySql = isPg
        ? `INSERT INTO emergencies (id, name, type, phone, address, location_lat, location_lng, city)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'Rewari')`
        : `INSERT INTO emergencies (id, name, type, phone, address, location_lat, location_lng, city)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Rewari')`
      database.prepare(insertEmergencySql).run(id, e.name, e.type, e.phone, e.address, e.lat, e.lng)
    }
    console.log('[db init] Bootstrapped production emergency contacts')
  }

  // Ensure default landmarks, temples, and transit stands exist in buildings
  const countBuildingsSql = 'SELECT COUNT(*) as count FROM buildings'
  const buildingsCount = database.prepare(countBuildingsSql).get() as any
  const bCountVal = buildingsCount?.count ?? buildingsCount?.countVal ?? 0

  if (Number(bCountVal) === 0) {
    const buildingsList = [
      // Heritage
      { name: 'Rewari Steam Locomotive Shed', type: 'heritage', address: 'Railway Colony, Rewari', timings: '9:00 AM - 5:00 PM', contact: '01274-256613', services: ['Museum', 'Guided Tours', 'Souvenirs'], description: 'Established in 1893, it is the only surviving steam locomotive shed in India. It houses some of India\'s oldest steam engines, including the legendary Fairy Queen.', lat: 28.1882, lng: 76.6231 },
      { name: 'Rao Tej Singh Talaab (Bada Talaab)', type: 'heritage', address: 'Tej Singh Talaab, Rewari', timings: 'Open 24 hours', contact: '', services: ['Bathing Ghats', 'Historic Temple', 'Walkway'], description: 'Built in 1815 by Rao Tej Singh. It features separate bathing ghats for men and women and a beautiful historic temple structure surrounding the reservoir.', lat: 28.1963, lng: 76.6083 },
      { name: 'Baoli Ghaus Ali Shah', type: 'heritage', address: 'Near Ghaus Ali Shah Masjid, Rewari', timings: '8:00 AM - 6:00 PM', contact: '', services: ['Stepwell Archeology', 'Rest rooms'], description: 'A historic three-storey stepwell constructed in the 18th century by Ghaus Ali Shah. It features an octagonal structure, restful rooms, and unique architectural archways.', lat: 28.2045, lng: 76.6110 },
      { name: 'Rampura House', type: 'heritage', address: 'Rampura, Rewari', timings: 'Private property (external view)', contact: '', services: ['Historical Residence', 'Heritage Architecture'], description: 'The historic residence of the descendants of Rao Tula Ram (a prominent hero of the 1857 Indian Mutiny), showcasing a mix of Rajput and colonial architecture.', lat: 28.1906, lng: 76.6062 },
      // Worship / Temples
      { name: 'Ghanteshwar Mandir', type: 'worship', address: 'Main Bazar, Rewari', timings: '5:00 AM - 9:00 PM', contact: '', services: ['Daily Aarti', 'Festivals'], description: 'A famous historic temple in the heart of Rewari dedicated to Lord Shiva and other Hindu deities. Visited by thousands of devotees daily.', lat: 28.1948, lng: 76.6135 },
      { name: 'Bhagwan Parshuram Mandir', type: 'worship', address: 'Model Town, Rewari', timings: '6:00 AM - 8:30 PM', contact: '', services: ['Religious Events', 'Community Hall'], description: 'A beautifully designed modern temple located in Model Town, dedicated to Lord Parshuram. Popular local landmark.', lat: 28.1895, lng: 76.6275 },
      // Transit
      { name: 'Rewari Junction Railway Station', type: 'transport', address: 'Station Road, Rewari', timings: 'Open 24 hours', contact: '01274-256612', services: ['8 Platforms', 'Waiting Rooms', 'Food stalls'], description: 'Major junction connecting Rewari to Delhi, Alwar, Rohtak, Bikaner, and Ringus. A historical junction established in 1873.', lat: 28.1983, lng: 76.6190 },
      { name: 'Rewari Central Bus Stand', type: 'transport', address: 'Jhajjar Road, Rewari', timings: 'Open 24 hours', contact: '01274-254321', services: ['Haryana Roadways', 'Local Booking Office', 'Restrooms'], description: 'Haryana Roadways central terminal on Jhajjar Road. Regular buses to Gurugram, Delhi, Narnaul, Jhajjar, and Rohtak.', lat: 28.1985, lng: 76.6265 },
      { name: 'Brass Market Auto Stand', type: 'transport', address: 'Brass Market Main Chowk, Rewari', timings: '6:00 AM - 10:00 PM', contact: '', services: ['E-Rickshaws', 'Sharing Autos'], description: 'Centrally located stand for E-Rickshaws and autos servicing Model Town, Sector 3, Brass Market, and nearby markets.', lat: 28.1892, lng: 76.6225 },
      { name: 'Dharuhera Chauk Bypass Auto Stand', type: 'transport', address: 'Dharuhera Chauk Bypass, Rewari', timings: '6:00 AM - 9:00 PM', contact: '', services: ['Sharing Autos', 'Inter-city travel boarding'], description: 'Major intersection boarding point for local sharing autos towards Dharuhera industrial town, Bawal, and NH-48 bypass.', lat: 28.2048, lng: 76.6375 },
      // Govt
      { name: 'District & Sessions Court Rewari', type: 'govt', address: 'District Secretariat, Sector 1, Rewari', timings: '10:00 AM - 5:00 PM', contact: '01274-250001', services: ['Judicial services', 'Notary public', 'Advocate chambers'], description: 'Primary judicial court complex for Rewari district legal matters.', lat: 28.1920, lng: 76.6205 },
      { name: 'Tehsil Office Rewari', type: 'govt', address: 'Old Court Road, Rewari', timings: '9:00 AM - 5:00 PM', contact: '01274-256617', services: ['Land Registration', 'Certificates', 'Citizen Helpdesk'], description: 'Government administrative department responsible for local land records and municipal documentation.', lat: 28.1955, lng: 76.6150 },
    ]
    for (const b of buildingsList) {
      const id = Math.random().toString(36).substring(2, 15)
      const insertBuildingSql = isPg
        ? `INSERT INTO buildings (id, name, type, address, timings, contact, services, description, photos, city_id, location_lat, location_lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rewari', $10, $11)`
        : `INSERT INTO buildings (id, name, type, address, timings, contact, services, description, photos, city_id, location_lat, location_lng)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rewari', ?, ?)`
      database.prepare(insertBuildingSql).run(
        id, b.name, b.type, b.address, b.timings, b.contact,
        JSON.stringify(b.services), b.description, JSON.stringify([]),
        b.lat, b.lng
      )
    }
    console.log('[db init] Bootstrapped production landmarks, temples, transit hubs, and government buildings')
  }

  // Ensure Surrounding Forest and Wildlife Areas exist
  const countJhabuaSql = "SELECT COUNT(*) as count FROM buildings WHERE name = 'Jhabua Reserve Forest & Wildlife Area'"
  const jhabuaExists = database.prepare(countJhabuaSql).get() as any
  const jCountVal = jhabuaExists?.count ?? jhabuaExists?.countVal ?? 0

  if (Number(jCountVal) === 0) {
    const forests = [
      { name: 'Jhabua Reserve Forest & Wildlife Area', type: 'heritage', address: 'Jhabua, Rewari Haryana', timings: 'Sunrise - Sunset', contact: '', services: ['Wildlife Spotting', 'Eco Trails', 'Nature Photography'], description: 'A protected forest reserve spanning several acres, housing regional wildlife (deer, peacocks, nilgai) and native arid vegetation of the Aravalli foothills.', lat: 28.0845, lng: 76.5820 },
      { name: 'Masani Barrage Wetland & Forest Reserve', type: 'heritage', address: 'Masani Village, NH-48 Bypass, Rewari', timings: 'Open 24 hours', contact: '', services: ['Birdwatching', 'Wetland Conservations', 'Photography'], description: 'Located on the Sahibi River, this reserve forest and wetland area serves as a major ecological site for migratory birds and natural groundwater recharging.', lat: 28.2215, lng: 76.7125 },
    ]
    for (const f of forests) {
      const id = Math.random().toString(36).substring(2, 15)
      const insertForestSql = isPg
        ? `INSERT INTO buildings (id, name, type, address, timings, contact, services, description, photos, city_id, location_lat, location_lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rewari', $10, $11)`
        : `INSERT INTO buildings (id, name, type, address, timings, contact, services, description, photos, city_id, location_lat, location_lng)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rewari', ?, ?)`
      database.prepare(insertForestSql).run(
        id, f.name, f.type, f.address, f.timings, f.contact,
        JSON.stringify(f.services), f.description, JSON.stringify([]),
        f.lat, f.lng
      )
    }
    console.log('[db init] Bootstrapped surrounding reserve forests and wildlife areas')
  }

  // Ensure SALTEDHASH and TRIU businesses exist
  const countBizSql = 'SELECT COUNT(*) as count FROM businesses'
  const businessCount = database.prepare(countBizSql).get() as any
  const bizCountVal = businessCount?.count ?? businessCount?.countVal ?? 0

  if (Number(bizCountVal) === 0) {
    const defaultBiz = [
      { id: 'biz_saltedhash', name: 'SALTEDHASH', slug: 'saltedhash-site', category: 'Services', subcategory: 'Software Development', address: 'Model Town, Rewari', phone: '01274-999888', lat: 28.1915, lng: 76.6240, priority: 100, verified: 1 },
      { id: 'biz_tri', name: 'TRIU', slug: 'triu-site', category: 'Services', subcategory: 'Business Consulting', address: 'Sector 3, Rewari', phone: '01274-888777', lat: 28.1960, lng: 76.6290, priority: 90, verified: 1 },
    ]
    for (const b of defaultBiz) {
      const insertBizSql = isPg
        ? `INSERT INTO businesses (id, name, slug, category, subcategory, address, phone, verified, rating_avg, rating_count, status, location_lat, location_lng, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 'active', $9, $10, $11)`
        : `INSERT INTO businesses (id, name, slug, category, subcategory, address, phone, verified, rating_avg, rating_count, status, location_lat, location_lng, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, ?, ?)`
      database.prepare(insertBizSql).run(b.id, b.name, b.slug, b.category, b.subcategory, b.address, b.phone, b.verified, b.lat, b.lng, b.priority)
    }
    console.log('[db init] Bootstrapped priority businesses: SALTEDHASH and TRIU')
  }
}

function getSchema(isPg: boolean): string[] {
  const dType = isPg ? 'TIMESTAMP' : 'DATETIME'
  const realType = isPg ? 'DOUBLE PRECISION' : 'REAL'
  return [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT 'User',
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','owner','admin')),
      locality_id TEXT,
      points INTEGER DEFAULT 0,
      last_seen_at ${dType},
      last_lat ${realType},
      last_lng ${realType},
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS localities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT,
      center_lat ${realType},
      center_lng ${realType},
      radius_km ${realType} DEFAULT 5,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      image_url TEXT,
      location_lat ${realType},
      location_lng ${realType},
      locality_id TEXT REFERENCES localities(id),
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS post_upvotes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT,
      tags TEXT DEFAULT '[]',
      description TEXT,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      whatsapp TEXT,
      hours TEXT DEFAULT '{}',
      photos TEXT DEFAULT '[]',
      attributes TEXT DEFAULT '{"parking":false,"cards":false,"homeDelivery":false}',
      owner_id TEXT REFERENCES users(id),
      verified INTEGER DEFAULT 0,
      verified_at ${dType},
      plan TEXT DEFAULT 'free' CHECK (plan IN ('free','promoted')),
      rating_avg ${realType} DEFAULT 0,
      rating_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK (status IN ('active','pending','suspended')),
      location_lat ${realType} NOT NULL,
      location_lng ${realType} NOT NULL,
      locality_id TEXT REFERENCES localities(id),
      priority INTEGER DEFAULT 0,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS circles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      creator_id TEXT NOT NULL REFERENCES users(id),
      pin TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS circle_members (
      id TEXT PRIMARY KEY,
      circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT DEFAULT 'member' CHECK (role IN ('member','elder','co_admin','admin')),
      joined_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(circle_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS circle_requests (
      id TEXT PRIMARY KEY,
      circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(circle_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      pin TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType},
      expires_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS buildings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT,
      timings TEXT,
      contact TEXT,
      services TEXT DEFAULT '[]',
      description TEXT,
      photos TEXT DEFAULT '[]',
      city_id TEXT,
      location_lat ${realType},
      location_lng ${realType},
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS emergencies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT,
      location_lat ${realType},
      location_lng ${realType},
      city TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      text TEXT,
      owner_reply TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      deleted_at ${dType}
    )`,

    `CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      discount TEXT NOT NULL,
      code TEXT,
      valid_from ${dType} NOT NULL,
      valid_to ${dType} NOT NULL,
      status TEXT DEFAULT 'active' CHECK (status IN ('active','expired','disabled')),
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      listing_id TEXT,
      user_id TEXT REFERENCES users(id),
      meta TEXT DEFAULT '{}',
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS business_claim_requests (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      requester_id TEXT NOT NULL REFERENCES users(id),
      private_contact_name TEXT,
      private_contact_phone TEXT,
      private_contact_email TEXT,
      verification_note TEXT,
      evidence_reference TEXT,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at ${dType},
      admin_note TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS business_verification_events (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      admin_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      note TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS user_saved_places (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, business_id)
    )`,

    `CREATE TABLE IF NOT EXISTS rewari_articles (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      content_markdown TEXT NOT NULL,
      content_html TEXT,
      category TEXT NOT NULL CHECK (category IN ('history','heritage','places','services','businesses','events','future','guides')),
      locality TEXT,
      status TEXT DEFAULT 'draft' CHECK (status IN ('draft','pending_review','published','rejected','archived')),
      author_id TEXT NOT NULL REFERENCES users(id),
      reviewer_id TEXT REFERENCES users(id),
      source_reference TEXT,
      last_verified_at ${dType},
      published_at ${dType},
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS article_revisions (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL REFERENCES rewari_articles(id) ON DELETE CASCADE,
      content_markdown TEXT NOT NULL,
      editor_id TEXT NOT NULL REFERENCES users(id),
      change_summary TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_locality ON users(locality_id)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_locality ON posts(locality_id)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_slug ON businesses(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_locality ON businesses(locality_id)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status)`,
    `CREATE INDEX IF NOT EXISTS idx_businesses_verified ON businesses(verified)`,
    `CREATE INDEX IF NOT EXISTS idx_circles_creator ON circles(creator_id)`,
    `CREATE INDEX IF NOT EXISTS idx_circle_members_circle ON circle_members(circle_id)`,
    `CREATE INDEX IF NOT EXISTS idx_circle_members_user ON circle_members(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_channels_circle ON channels(circle_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_offers_business ON offers(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_offers_valid ON offers(valid_from, valid_to)`,
    `CREATE INDEX IF NOT EXISTS idx_business_claims_business ON business_claim_requests(business_id)`,
    `CREATE INDEX IF NOT EXISTS idx_business_claims_requester ON business_claim_requests(requester_id)`,
    `CREATE INDEX IF NOT EXISTS idx_business_claims_status ON business_claim_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_rewari_articles_slug ON rewari_articles(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_rewari_articles_category ON rewari_articles(category)`,
    `CREATE INDEX IF NOT EXISTS idx_rewari_articles_status ON rewari_articles(status)`,
    `CREATE INDEX IF NOT EXISTS idx_rewari_articles_author ON rewari_articles(author_id)`,
    `CREATE INDEX IF NOT EXISTS idx_article_revisions_article ON article_revisions(article_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_saved_places_user ON user_saved_places(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_saved_places_business ON user_saved_places(business_id)`,

    `CREATE TABLE IF NOT EXISTS user_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip TEXT,
      user_agent TEXT,
      device_type TEXT,
      os TEXT,
      browser TEXT,
      lat ${realType},
      lng ${realType},
      connected_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_connections_user ON user_connections(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_connections_time ON user_connections(connected_at)`,

    `CREATE TABLE IF NOT EXISTS api_audit_logs (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      response_time INTEGER,
      ip TEXT,
      user_id TEXT,
      headers TEXT,
      query TEXT,
      created_at ${dType} DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_api_audit_logs_time ON api_audit_logs(created_at)`
  ]
}