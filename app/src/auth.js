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

function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect("/login");
    next();
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.session.user) return res.redirect("/login");
        if (req.session.user.role !== role) {
            return res.status(403).send(`This page requires the ${role} role.`);
        }
        next();
    };
}

module.exports = { initOidcClient, registerAuthRoutes, requireAuth, requireRole };
