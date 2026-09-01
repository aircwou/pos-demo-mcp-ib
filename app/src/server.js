const path = require("path");
const express = require("express");
const session = require("express-session");
const pgSessionFactory = require("connect-pg-simple");
const { pool, ensureSchema } = require("./db");
const { initOidcClient, registerAuthRoutes, requireAuth, requireRole } = require("./auth");
const productsRoutes = require("./routes/products");
const salesRoutes = require("./routes/sales");
const reportsRoutes = require("./routes/reports");

async function main() {
    await ensureSchema();
    await initOidcClient();

    const PgSession = pgSessionFactory(session);
    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "..", "views"));
    app.use(express.urlencoded({ extended: false }));
    app.use(
        session({
            store: new PgSession({ pool, tableName: "session" }),
            secret: process.env.SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
        }),
    );

    registerAuthRoutes(app);

    // Checkout screen — the Cashier's (and Manager's) main working page.
    app.get("/", requireAuth, async (req, res, next) => {
        try {
            const { rows: products } = await pool.query("SELECT * FROM products ORDER BY category, name");
            res.render("checkout", { products, user: req.session.user });
        } catch (err) {
            next(err);
        }
    });

    // Manager dashboard — product management + links to all-sales/report.
    // requireRole handles both "not logged in" (redirect to /login) and
    // "logged in but not Manager" (403) — see auth.js.
    app.get("/manager", requireAuth, requireRole("MANAGER"), async (req, res, next) => {
        try {
            const { rows: products } = await pool.query("SELECT * FROM products ORDER BY category, name");
            res.render("manager", { products, user: req.session.user });
        } catch (err) {
            next(err);
        }
    });

    app.use("/products", requireAuth, productsRoutes);
    app.use("/sales", requireAuth, salesRoutes);
    app.use("/reports", requireAuth, requireRole("MANAGER"), reportsRoutes);

    app.use((err, req, res, next) => {
        console.error(err);
        res.status(500).send(`<pre>${err.stack}</pre>`);
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`[server] listening on :${port}`));
}

main().catch((e) => {
    console.error("[server] fatal startup error:", e);
    process.exit(1);
});
