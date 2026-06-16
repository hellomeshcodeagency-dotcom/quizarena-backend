const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

const query = (text, params) => pool.query(text, params);
const getClient = () => pool.connect();

const migrate = async () => {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('✅ Database schema applied');

    // Run any extra migrations that may not be in schema.sql yet
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
    `);
    console.log('✅ Extra migrations applied');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  }
};

module.exports = { pool, query, getClient, migrate };
