/**
 * create_avirat_tables.js
 *
 * Creates DB "avirat" (if missing) and all required tables in Postgres on localhost (Docker Desktop).
 *
 * Connection defaults:
 *   host: localhost
 *   port: 5432
 *   user: postgres
 *   password: postgres
 *
 * Run:
 *   npm i pg
 *   node create_avirat_tables.js
 */

import pkg from "pg";
const { Client } = pkg;

const PG_HOST = process.env.PGHOST || "localhost";
const PG_PORT = Number(process.env.PGPORT || 5432);
const PG_USER = process.env.PGUSER || "postgres";
const PG_PASSWORD = process.env.PGPASSWORD || "postgres";

const TARGET_DB = "avirat";

function makeClient(database) {
  return new Client({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database,
  });
}

async function ensureDatabaseExists() {
  const admin = makeClient("postgres"); // connect to default db to create avirat
  await admin.connect();

  try {
    const exists = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [TARGET_DB]
    );

    if (exists.rowCount === 0) {
      console.log(`Database "${TARGET_DB}" does not exist. Creating...`);
      // CREATE DATABASE cannot run inside a transaction, so keep it simple
      await admin.query(`CREATE DATABASE ${TARGET_DB}`);
      console.log(`Database "${TARGET_DB}" created ✅`);
    } else {
      console.log(`Database "${TARGET_DB}" already exists ✅`);
    }
  } finally {
    await admin.end();
  }
}

async function createSchema() {
  const db = makeClient(TARGET_DB);
  await db.connect();

  try {
    await db.query("BEGIN");

    // Use safe, non-reserved table names: users, orders, order_items
    // Store YYMMDD as integer with basic checks: 0..991231 and 6 digits.
    // If you want strict YYMMDD validation (incl. month/day ranges), we can add a function/check.

    await db.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        UNIQUE (category_id, name)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone_number TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS products (
        id BIGSERIAL PRIMARY KEY,
        product_name TEXT NOT NULL,
        weight_grams INTEGER NOT NULL CHECK (weight_grams > 0),
        category_id BIGINT NOT NULL REFERENCES categories(id),
        subcategory_id BIGINT REFERENCES subcategories(id),
        price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- Optional consistency constraint: if subcategory_id exists, it must belong to category_id
        -- Enforced via trigger if you want (Postgres can't enforce cross-table checks directly).
        UNIQUE (product_name, category_id, subcategory_id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        consumer_id BIGINT NOT NULL REFERENCES users(id),
        order_date_yymmdd INTEGER NOT NULL CHECK (order_date_yymmdd BETWEEN 0 AND 991231),
        order_amount NUMERIC(12,2) NOT NULL CHECK (order_amount >= 0),
        items_count INTEGER NOT NULL CHECK (items_count >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id BIGINT NOT NULL REFERENCES products(id),
        subcategory_id BIGINT REFERENCES subcategories(id),
        order_date_yymmdd INTEGER NOT NULL CHECK (order_date_yymmdd BETWEEN 0 AND 991231),
        price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0)
      );
    `);

    // Helpful indexes
    await db.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_products_subcategory ON products(subcategory_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_consumer_date ON orders(consumer_id, order_date_yymmdd);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);`);

    await db.query("COMMIT");
    console.log(`All tables created in "${TARGET_DB}" ✅`);
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("Failed to create schema:", e);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

async function main() {
  await ensureDatabaseExists();
  await createSchema();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
