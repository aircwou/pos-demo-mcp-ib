const express = require("express");
const { pool } = require("../db");
const { requireRole } = require("../auth");

const router = express.Router();

// Mounted at /sales with requireAuth already applied at mount time.

// Ring up a sale — any authenticated user (Cashier's core job; Manager can
// too, since "everything a Cashier can do" is part of the role definition).
// Body: { items: [{ product_id, quantity }, ...] } (JSON) — checkout.ejs
// posts this via fetch, not a plain HTML form, since it needs to send an
// array of line items.
router.post("/", express.json(), async (req, res, next) => {
    const client = await pool.connect();
    try {
        const items = Array.isArray(req.body.items) ? req.body.items : [];
        if (items.length === 0) {
            return res.status(400).json({ error: "Cart is empty" });
        }

        await client.query("BEGIN");

        let totalCents = 0;
        const lineItems = [];
        for (const item of items) {
            const productId = Number(item.product_id);
            const quantity = Number(item.quantity);
            if (!productId || !quantity || quantity < 1) {
                throw Object.assign(new Error("Invalid line item"), { statusCode: 400 });
            }
            const { rows } = await client.query(
                "SELECT id, name, price_cents, stock_qty FROM products WHERE id = $1 FOR UPDATE",
                [productId],
            );
            const product = rows[0];
            if (!product) {
                throw Object.assign(new Error(`Product ${productId} not found`), { statusCode: 404 });
            }
            if (product.stock_qty < quantity) {
                throw Object.assign(
                    new Error(`Not enough stock for ${product.name} (have ${product.stock_qty}, wanted ${quantity})`),
                    { statusCode: 409 },
                );
            }
            totalCents += product.price_cents * quantity;
            lineItems.push({ productId, quantity, unitPriceCents: product.price_cents });
        }

        const { rows: saleRows } = await client.query(
            "INSERT INTO sales (cashier_email, total_cents) VALUES ($1, $2) RETURNING id",
            [req.session.user.email, totalCents],
        );
        const saleId = saleRows[0].id;

        for (const li of lineItems) {
            await client.query(
                "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
                [saleId, li.productId, li.quantity, li.unitPriceCents],
            );
            await client.query("UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2", [
                li.quantity, li.productId,
            ]);
        }

        await client.query("COMMIT");
        res.status(201).json({ saleId, totalCents });
    } catch (err) {
        await client.query("ROLLBACK");
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        next(err);
    } finally {
        client.release();
    }
});

// Own sales history — any authenticated user.
router.get("/mine", async (req, res, next) => {
    try {
        const { rows: sales } = await pool.query(
            `SELECT s.*, COALESCE(json_agg(json_build_object(
                 'product_name', p.name, 'quantity', si.quantity, 'unit_price_cents', si.unit_price_cents
             )) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
             FROM sales s
             LEFT JOIN sale_items si ON si.sale_id = s.id
             LEFT JOIN products p ON p.id = si.product_id
             WHERE s.cashier_email = $1
             GROUP BY s.id ORDER BY s.created_at DESC`,
            [req.session.user.email],
        );
        res.render("my-sales", { sales, user: req.session.user });
    } catch (err) {
        next(err);
    }
});

// All sales — Manager only.
router.get("/", requireRole("MANAGER"), async (req, res, next) => {
    try {
        const { rows: sales } = await pool.query(
            `SELECT s.*, COALESCE(json_agg(json_build_object(
                 'product_name', p.name, 'quantity', si.quantity, 'unit_price_cents', si.unit_price_cents
             )) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
             FROM sales s
             LEFT JOIN sale_items si ON si.sale_id = s.id
             LEFT JOIN products p ON p.id = si.product_id
             GROUP BY s.id ORDER BY s.created_at DESC`,
        );
        res.render("all-sales", { sales, user: req.session.user });
    } catch (err) {
        next(err);
    }
});

// Void a sale — Manager only. Does not restock (a real POS might, but
// that's a deliberate choice, not an oversight — keeping this demo's
// domain logic simple).
router.post("/:id/void", requireRole("MANAGER"), async (req, res, next) => {
    try {
        await pool.query(
            "UPDATE sales SET status = 'VOIDED', voided_at = now() WHERE id = $1 AND status = 'COMPLETED'",
            [Number(req.params.id)],
        );
        res.redirect("/sales");
    } catch (err) {
        next(err);
    }
});

module.exports = router;
