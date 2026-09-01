const { Pool } = require('pg');

// Railway (and most hosts) inject DATABASE_URL automatically when you attach
// a Postgres add-on. Locally, set it in .env to point at your own Postgres.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false)
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_ids JSONB NOT NULL DEFAULT '[]',
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT,
      media_url TEXT,
      media_type TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, created_at);`);
  console.log('Database ready');
}

module.exports = { pool, init };
