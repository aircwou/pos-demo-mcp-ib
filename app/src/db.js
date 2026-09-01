const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Neon's pooled connection requires TLS; rejectUnauthorized: false avoids
// environment-specific CA store issues (same reasoning as most Neon
// quickstarts) -- this is a demo DB with no sensitive data, not a
// production posture decision.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const ROLES = ["CASHIER", "MANAGER"];

async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            email TEXT PRIMARY KEY,
            sub TEXT,
            name TEXT,
            role TEXT NOT NULL CHECK (role IN ('CASHIER', 'MANAGER'))
        );

        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            sku TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            price_cents INTEGER NOT NULL,
            stock_qty INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sales (
            id SERIAL PRIMARY KEY,
            cashier_email TEXT NOT NULL REFERENCES users(email),
            status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'VOIDED')),
            total_cents INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            voided_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS sale_items (
            id SERIAL PRIMARY KEY,
            sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id),
            quantity INTEGER NOT NULL,
            unit_price_cents INTEGER NOT NULL
        );

        -- connect-pg-simple's own session store table (its documented schema).
        CREATE TABLE IF NOT EXISTS session (
            sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
            sess JSON NOT NULL,
            expire TIMESTAMP(6) NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
    `);

    // Seed the two test users with fixed roles, matching the plan. Email is
    // the primary key and the only identity this app cares about at this
    // phase (sub is filled in lazily on first real Dex login, see auth.js) --
    // upsert so re-running seed doesn't clobber a sub already captured.
    const seedUsers = [
        { email: "sobitprasad79@gmail.com", role: "CASHIER" },
        { email: "pankajkumar.singh@woxsen.edu.in", role: "MANAGER" },
    ];
    for (const u of seedUsers) {
        await pool.query(
            `INSERT INTO users (email, role) VALUES ($1, $2)
             ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role`,
            [u.email, u.role],
        );
    }

    // Seed products once, only if the table is empty -- safe to re-run.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM products");
    if (rows[0].n === 0) {
        const seedPath = path.join(__dirname, "..", "seed", "products.json");
        const products = JSON.parse(fs.readFileSync(seedPath, "utf8"));
        for (const p of products) {
            await pool.query(
                "INSERT INTO products (sku, name, category, price_cents, stock_qty) VALUES ($1, $2, $3, $4, $5)",
                [p.sku, p.name, p.category, p.price_cents, p.stock_qty],
            );
        }
        console.log(`[db] seeded ${products.length} products`);
    }
}

module.exports = { pool, ensureSchema, ROLES };
