const { Issuer, generators } = require("openid-client");

let client;

/**
 * Discover Dex's OIDC configuration and build the RP client.
 *
 * Unlike the real-estate demo (same Dex instance, different app), this
 * container is NOT on the same Docker network as Dex -- it's a separate
 * project/compose stack -- so it can't reach the `dex:5556` internal
 * hostname the way that app does. Using the PUBLIC Dex URL uniformly for
 * both the browser-facing and server-side (discovery, token exchange)
 * requests avoids needing that dual-hostname rewrite entirely; the cost is
 * server-side calls round-tripping through Cloudflare instead of a fast
 * internal hop, acceptable for a demo.
 */
async function initOidcClient() {
    const attempts = 5;
    for (let i = 1; i <= attempts; i++) {
        try {
            const issuer = await Issuer.discover(process.env.OIDC_DISCOVERY_URL);
            client = new issuer.Client({
                client_id: process.env.OIDC_CLIENT_ID,
                client_secret: process.env.OIDC_CLIENT_SECRET,
                redirect_uris: [process.env.OIDC_REDIRECT_URI],
                response_types: ["code"],
            });
            console.log(`[auth] discovered OIDC issuer: ${issuer.metadata.issuer}`);
            return;
        } catch (err) {
            console.warn(`[auth] OIDC discovery attempt ${i}/${attempts} failed: ${err.message}`);
            if (i === attempts) throw err;
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
}

function registerAuthRoutes(app) {
    app.get("/login", (req, res) => {
        const nonce = generators.nonce();
        const state = generators.state();
        req.session.nonce = nonce;
        req.session.state = state;
        res.redirect(
            client.authorizationUrl({ scope: "openid email profile", nonce, state }),
        );
    });

    app.get("/callback", async (req, res, next) => {
        try {
            const params = client.callbackParams(req);
            const tokenSet = await client.callback(process.env.OIDC_REDIRECT_URI, params, {
                nonce: req.session.nonce,
                state: req.session.state,
            });
            // tokenSet.claims() is already signature/issuer/audience/nonce-verified
            // by openid-client at this point -- this IS the token-validation step.
            const claims = tokenSet.claims();

            if (!claims.email) {
                delete req.session.nonce;
                delete req.session.state;
                return res.status(403).send(
                    "This GitHub account has no email available via Dex. " +
                    "This app identifies users by email -- sign in with an " +
                    "account that has one, or contact an admin to be added.",
                );
            }

            req.session.user = {
                sub: claims.sub,
                email: claims.email,
                name: claims.name,
                picture: claims.picture
                    ?? (claims.preferred_username ? `https://github.com/${claims.preferred_username}.png` : null),
            };
            delete req.session.nonce;
            delete req.session.state;

            // Keep `sub` current on the seeded user row (mirrors the
            // real-estate demo's lesson: email is the durable identity key,
            // sub is just useful metadata, not something to key data on).
            const { pool } = require("./db");
            await pool.query("UPDATE users SET sub = $1, name = $2 WHERE email = $3", [
                claims.sub, claims.name ?? null, claims.email,
            ]);

            const { rows } = await pool.query("SELECT role FROM users WHERE email = $1", [claims.email]);
            if (rows.length === 0) {
                return res.status(403).send(
                    `${claims.email} is not a registered user of this POS demo. ` +
                    "Ask an admin to add your email with a role.",
                );
            }
            req.session.user.role = rows[0].role;

            res.redirect("/");
        } catch (err) {
            next(err);
        }
    });

    app.get("/logout", (req, res) => {
        req.session.destroy(() => res.redirect("/"));
    });
}

async function verifyBearerToken(token) {
    if (!token) return null;

    // Verify Bearer token directly against Dex's OIDC userinfo endpoint
    if (client) {
        try {
            const userinfo = await client.userinfo(token);
            if (userinfo && userinfo.email) {
                return {
                    email: userinfo.email,
                    sub: userinfo.sub,
                    name: userinfo.name || null,
                    picture: userinfo.picture || null,
                };
            }
        } catch (err) {
            console.debug("[auth] Dex OIDC token verification failed:", err.message);
        }
    }

    return null;
}

async function requireAuth(req, res, next) {
    // 1. Session-based auth (browser)
    if (req.session?.user) {
        req.user = req.session.user;
        return next();
    }

    // 2. Bearer token auth (API / MCPHub / AI agent)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7).trim();
        if (!token) {
            return res.status(401).json({ error: "Empty bearer token" });
        }

        try {
            const claims = await verifyBearerToken(token);
            if (!claims || !claims.email) {
                return res.status(401).json({ error: "Invalid or expired token" });
            }

            const { pool } = require("./db");
            const { rows } = await pool.query(
                "SELECT email, sub, name, role FROM users WHERE email = $1",
                [claims.email],
            );

            if (rows.length === 0) {
                return res.status(403).json({
                    error: `${claims.email} is not a registered user of this POS demo.`,
                });
            }

            if (claims.sub && !rows[0].sub) {
                await pool.query(
                    "UPDATE users SET sub = $1, name = COALESCE(name, $2) WHERE email = $3",
                    [claims.sub, claims.name ?? null, claims.email],
                );
            }

            req.user = {
                sub: claims.sub || rows[0].sub,
                email: rows[0].email,
                name: rows[0].name || claims.name,
                picture: claims.picture || null,
                role: rows[0].role,
            };

            if (req.session) {
                req.session.user = req.user;
            }

            return next();
        } catch (err) {
            console.error("[auth] Bearer token processing error:", err);
            return res.status(401).json({ error: "Authentication failed" });
        }
    }

    // 3. Unauthenticated request
    if (req.accepts("json") && !req.accepts("html")) {
        return res.status(401).json({ error: "Authentication required" });
    }

    res.redirect("/login");
}

function requireRole(role) {
    return (req, res, next) => {
        const user = req.user || req.session?.user;
        if (!user) {
            if (req.accepts("json") && !req.accepts("html")) {
                return res.status(401).json({ error: "Authentication required" });
            }
            return res.redirect("/login");
        }

        if (user.role !== role) {
            if (req.accepts("json") && !req.accepts("html")) {
                return res.status(403).json({ error: `This endpoint requires the ${role} role.` });
            }
            return res.status(403).send(`This page requires the ${role} role.`);
        }

        next();
    };
}

module.exports = { initOidcClient, registerAuthRoutes, requireAuth, requireRole, verifyBearerToken };

