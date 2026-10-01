const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Mounted at /reports with requireAuth + requireRole("MANAGER") both
// applied at mount time (see server.js) -- every route here is Manager-only.

router.get("/summary", async (req, res, next) => {
    try {
        const user = req.user || req.session?.user;
        const { rows: totals } = await pool.query(
            `SELECT
                 count(*) FILTER (WHERE status = 'COMPLETED') AS completed_count,
                 count(*) FILTER (WHERE status = 'VOIDED') AS voided_count,
                 COALESCE(sum(total_cents) FILTER (WHERE status = 'COMPLETED'), 0) AS revenue_cents
             FROM sales`,
        );
        const { rows: topProducts } = await pool.query(
            `SELECT p.name, sum(si.quantity) AS units_sold, sum(si.quantity * si.unit_price_cents) AS revenue_cents
             FROM sale_items si
             JOIN sales s ON s.id = si.sale_id AND s.status = 'COMPLETED'
             JOIN products p ON p.id = si.product_id
             GROUP BY p.name
             ORDER BY units_sold DESC
             LIMIT 5`,
        );
        if (req.headers.authorization || !req.accepts("html") || req.headers.accept?.includes("application/json")) {
            return res.json({ totals: totals[0], topProducts });
        }
        res.render("report", { totals: totals[0], topProducts, user });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
