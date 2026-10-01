const express = require("express");
const { pool } = require("../db");
const { requireRole } = require("../auth");

const router = express.Router();

// Mounted at /products with requireAuth already applied at mount time (see
// server.js) -- browsing the catalog is fine for any authenticated user
// (Cashier needs it to ring up a sale); only mutating it is Manager-only.

router.get("/", async (req, res, next) => {
    try {
        const user = req.user || req.session?.user;
        const { rows: products } = await pool.query("SELECT * FROM products ORDER BY category, name");
        if (req.headers.authorization || !req.accepts("html") || req.headers.accept?.includes("application/json")) {
            return res.json(products);
        }
        res.render("products", { products, user });
    } catch (err) {
        next(err);
    }
});

router.post("/", requireRole("MANAGER"), async (req, res, next) => {
    try {
        const { sku, name, category, price_cents, stock_qty } = req.body;
        if (!sku || !name || !category || !price_cents) {
            if (req.headers.authorization || !req.accepts("html") || req.headers.accept?.includes("application/json")) {
                return res.status(400).json({ error: "sku, name, category, and price_cents are required" });
            }
            return res.status(400).send("sku, name, category, and price_cents are required");
        }
        const { rows } = await pool.query(
            "INSERT INTO products (sku, name, category, price_cents, stock_qty) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            [sku, name, category, Number(price_cents), Number(stock_qty) || 0],
        );
        if (req.headers.authorization || !req.accepts("html") || req.headers.accept?.includes("application/json")) {
            return res.status(201).json(rows[0]);
        }
        res.redirect("/manager");
    } catch (err) {
        next(err);
    }
});

router.post("/:id/update", requireRole("MANAGER"), async (req, res, next) => {
    try {
        const { name, category, price_cents, stock_qty } = req.body;
        await pool.query(
            "UPDATE products SET name = $1, category = $2, price_cents = $3, stock_qty = $4 WHERE id = $5",
            [name, category, Number(price_cents), Number(stock_qty), Number(req.params.id)],
        );
        if (req.headers.authorization || !req.accepts("html") || req.headers.accept?.includes("application/json")) {
            return res.json({ success: true, id: Number(req.params.id) });
        }
        res.redirect("/manager");
    } catch (err) {
        next(err);
    }
});

router.post("/:id/delete", requireRole("MANAGER"), async (req, res, next) => {
    try {
        await pool.query("DELETE FROM products WHERE id = $1", [Number(req.params.id)]);
        if (req.headers.authorization || !req.accepts("html") || req.headers.accept?.includes("application/json")) {
            return res.json({ success: true, id: Number(req.params.id) });
        }
        res.redirect("/manager");
    } catch (err) {
        next(err);
    }
});

module.exports = router;
