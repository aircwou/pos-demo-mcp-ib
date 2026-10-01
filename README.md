# POS Demo

A small point-of-sale web app built with Express and EJS on Postgres. Users sign in with OpenID Connect (OIDC) through [Dex](https://dexidp.io/). Every user has one of two roles:

| Role | Can do |
|---|---|
| **Cashier** | Browse products, ring up sales, see their own sales |
| **Manager** | Everything a Cashier can do, plus manage products, see all sales, void sales, and view the sales report |

[Roles and permissions](#roles-and-permissions) has the full breakdown.

The app also accepts `Authorization: Bearer <token>` on its API routes, so scripts and agents can call it. The API is described in [pos-openapi.yaml](pos-openapi.yaml).

## What you need

- **Node.js 20.6 or newer**, for `node --env-file`
- **Postgres**: a local server or a hosted one such as Neon
- **An OIDC provider** that puts an `email` claim in the ID token. The steps below run Dex locally.
- **Docker**, only needed for the local Postgres and Dex in the quick start

## Get the code

The repository is public on GitHub: <https://github.com/aircwou/pos-demo-mcp-ib>

```bash
git clone https://github.com/aircwou/pos-demo-mcp-ib.git
cd pos-demo-mcp-ib
```

## Quick start (fully local)

This runs Postgres and Dex in Docker and the app on your machine. You don't need a GitHub app or any cloud account. Run the commands from the repository root (`pos-demo-mcp-ib/`).

### 1. Start Postgres

```bash
docker run -d --name pos-postgres \
  -e POSTGRES_USER=pos -e POSTGRES_PASSWORD=pos -e POSTGRES_DB=pos \
  -p 5432:5432 postgres:16-alpine
```

### 2. Start Dex with a local test login

Create `dex-local.yaml` in the repository root:

```yaml
issuer: http://localhost:5556/dex
storage:
  type: memory
web:
  http: 0.0.0.0:5556
oauth2:
  skipApprovalScreen: true
staticClients:
  - id: pos-app
    name: POS Demo
    secret: local-dev-secret
    redirectURIs:
      - http://localhost:3000/callback
enablePasswordDB: true
staticPasswords:
  - email: manager@example.com
    # bcrypt hash of "password"
    hash: "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W"
    username: manager
    userID: "11111111-1111-1111-1111-111111111111"
```

Start Dex:

```bash
docker run -d --name pos-dex -p 5556:5556 \
  -v "$PWD/dex-local.yaml:/etc/dex/config.yaml" \
  dexidp/dex:v2.41.1 dex serve /etc/dex/config.yaml
```

> In Git Bash on Windows, put `MSYS_NO_PATHCONV=1` in front of the command so the container paths aren't rewritten. In PowerShell, use `${PWD}` in place of `$PWD`.

Check that Dex is up: <http://localhost:5556/dex/.well-known/openid-configuration> should return JSON.

### 3. Configure the app

Create `.env` in the repository root. It is git-ignored.

```dotenv
DATABASE_URL=postgresql://pos:pos@localhost:5432/pos?sslmode=disable
OIDC_DISCOVERY_URL=http://localhost:5556/dex
OIDC_CLIENT_ID=pos-app
OIDC_CLIENT_SECRET=local-dev-secret
OIDC_REDIRECT_URI=http://localhost:3000/callback
SESSION_SECRET=change-me-to-a-long-random-string
PORT=3000
```

`?sslmode=disable` is required for a local Postgres. Without it, the app always requests TLS and fails with `The server does not support SSL connections`.

### 4. Install and run

```bash
cd app
npm install
node --env-file=../.env src/server.js
```

On the first start the app creates its tables and seeds 12 sample products. You should see:

```
[db] seeded 12 products
[auth] discovered OIDC issuer: http://localhost:5556/dex
[server] listening on :3000
```

### 5. Give your login a role

The app only lets in emails that are listed in its `users` table. Add the Dex test user as a Manager:

```bash
docker exec pos-postgres psql -U pos -d pos -c \
  "INSERT INTO users (email, role) VALUES ('manager@example.com', 'MANAGER')
   ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role;"
```

Use `'CASHIER'` to try the Cashier role.

### 6. Sign in

Open <http://localhost:3000> and sign in as `manager@example.com` with the password `password`. You land on **Checkout**. The Manager dashboard is at <http://localhost:3000/manager>.

### Clean up

```bash
docker rm -f pos-postgres pos-dex
```

## Configuration reference

The app reads these environment variables. It does not load `.env` by itself, so pass the file with `node --env-file`, through Docker Compose, or export the variables in your shell.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. Add `?sslmode=disable` for a server without TLS. |
| `OIDC_DISCOVERY_URL` | yes | Issuer URL. The app fetches `<url>/.well-known/openid-configuration` and makes 5 attempts, 2 s apart. |
| `OIDC_CLIENT_ID` | yes | OIDC client ID |
| `OIDC_CLIENT_SECRET` | yes | OIDC client secret |
| `OIDC_REDIRECT_URI` | yes | `<app base URL>/callback`. Must exactly match a redirect URI registered with the provider. |
| `SESSION_SECRET` | yes | Secret that signs the session cookie |
| `PORT` | no | HTTP port. Defaults to `3000`. |

## Roles and permissions

There are exactly two roles, `CASHIER` and `MANAGER`. A CHECK constraint on the `users` table enforces this. The roles are cumulative: a Manager can do everything a Cashier can, and more. No permission belongs only to Cashiers.

### Permission matrix

| Action | Cashier | Manager | Route |
|---|:---:|:---:|---|
| Sign in and open the Checkout screen | ✅ | ✅ | `GET /` |
| Browse the product catalog (JSON) | ✅ | ✅ | `GET /products` |
| Ring up a sale | ✅ | ✅ | `POST /sales` |
| View their own sales history | ✅ | ✅ | `GET /sales/mine` |
| Open the Manager dashboard | ❌ | ✅ | `GET /manager` |
| Add a product | ❌ | ✅ | `POST /products` |
| Edit a product's name, category, price or stock | ❌ | ✅ | `POST /products/:id/update` |
| Delete a product | ❌ | ✅ | `POST /products/:id/delete` |
| View every user's sales | ❌ | ✅ | `GET /sales` |
| Void a sale | ❌ | ✅ | `POST /sales/:id/void` |
| View the sales report | ❌ | ✅ | `GET /reports/summary` |

### Cashier

A Cashier's job is the Checkout screen.

- **Ring up sales.** Each sale is recorded under the signed-in user's email. The whole cart succeeds or fails together. If any line asks for more than the current stock, the sale is rejected with `409` and nothing is recorded. A successful sale takes the sold quantities out of stock.
- **See their own sales** at **My sales** (`/sales/mine`), including the line items. A Cashier can't see anyone else's sales.
- **Can't** change products, void sales, see other users' sales, or open the report. The Checkout screen shows the **Manager dashboard** link only to Managers.

### Manager

A Manager has every Cashier permission, plus the Manager dashboard (`/manager`):

- **Manage products.** Add, edit and delete products. This includes setting stock levels directly.
  - Adding a product requires `sku`, `name`, `category` and `price_cents`. `stock_qty` defaults to 0.
  - A product that appears in any sale can't be deleted, because sale line items reference it. Set its stock to 0 instead.
- **View all sales** from every user, with the line items.
- **Void a sale.** This marks a completed sale as `VOIDED` and records when. Voiding doesn't put the items back in stock, and a voided sale can't be restored.
- **Sales report.** Shows the number of completed and voided sales, revenue from completed sales only, and the top 5 products by units sold.

### How access is checked

- **Who you are.** Users are identified by email. After sign-in, or on each Bearer-token request, the app looks up the email in the `users` table. An email that isn't listed is refused with `403`, even if the identity provider accepted it.
- **Not signed in.** Browsers are redirected to `/login`. API clients get `401` JSON.
- **Wrong role.** Browsers get a `403` page saying the page requires the Manager role. API clients get `403` JSON.
- **Role changes.** A browser session keeps the role it had at sign-in. After changing someone's role in `users`, have them sign out at `/logout` and sign in again.

### Managing users

- There is no admin UI for users. Add a user or change a role with SQL:

  ```sql
  INSERT INTO users (email, role) VALUES ('someone@example.com', 'CASHIER')
  ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role;
  ```

- On **every** start, the app upserts two built-in demo accounts, defined in [app/src/db.js](app/src/db.js). Their roles are reset to those values each time, so change the code rather than the database if you want different roles for those two emails.
- The OIDC `sub` is stored only as metadata. Access never depends on it.
- Products are seeded from [app/seed/products.json](app/seed/products.json), but only while the `products` table is empty.

## Using a real identity provider

Any OIDC provider works if it includes an `email` claim. The hosted demo uses Dex with a GitHub connector. To use your own provider:

1. Register a client with the redirect URI `http(s)://<your host>/callback`.
2. Set `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI` to match.
3. Add each person's email to the `users` table.

GitHub accounts without a public or verified email reach Dex without an email claim, and the app rejects them.

## Docker Compose (hosted deployment)

[docker-compose.yml](docker-compose.yml) is set up for the hosted demo, not for local use:

- Dex is at `https://dexauth.authio.ai/dex`, and the redirect URI is `https://posdemo.authio.ai/callback`. Both are hard-coded in the compose file.
- The app is published on host port **3002**.
- `DATABASE_URL`, `POS_DEX_CLIENT_SECRET` and `SESSION_SECRET` come from `.env`. See [.env.example](.env.example).

```bash
cp .env.example .env   # then fill in the values
docker compose up --build
```

This only works if you have the `pos-app` client secret for that Dex instance and traffic for `posdemo.authio.ai` is routed to the container. Otherwise use the quick start above, or change the `OIDC_*` values in the compose file to point at your own provider.

## Routes

The browser UI is session-based. The same routes accept a Bearer access token from the configured provider. The token is checked against the provider's userinfo endpoint, and the email it returns must be in `users`.

| Method & path | Role | Purpose |
|---|---|---|
| `GET /` | any | Checkout screen |
| `GET /manager` | Manager | Product management dashboard |
| `GET /products` | any | List products |
| `POST /products` | Manager | Create a product |
| `POST /products/:id/update` | Manager | Update a product |
| `POST /products/:id/delete` | Manager | Delete a product |
| `POST /sales` | any | Ring up a sale. Body: `{ "items": [{ "product_id": 1, "quantity": 2 }] }` |
| `GET /sales/mine` | any | Your own sales |
| `GET /sales` | Manager | All sales |
| `POST /sales/:id/void` | Manager | Void a sale |
| `GET /reports/summary` | Manager | Sales summary report |
| `GET /login`, `GET /callback`, `GET /logout` | n/a | OIDC sign-in flow |

Prices are stored in cents (`price_cents`, `total_cents`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `The server does not support SSL connections` | Your Postgres has no TLS. Add `?sslmode=disable` to `DATABASE_URL`. |
| `OIDC discovery attempt 5/5 failed`, then exit | `OIDC_DISCOVERY_URL` can't be reached, or it isn't the issuer URL. Open `<url>/.well-known/openid-configuration` in a browser to check. |
| Dex shows `Unregistered redirect_uri` | `OIDC_REDIRECT_URI` doesn't exactly match the client's `redirectURIs`. Check the scheme, host, port and path. |
| `… is not a registered user of this POS demo` | Insert that email into `users` (step 5). |
| `This page requires the MANAGER role.` | Your user's role is `CASHIER`. Change it in `users`, then sign out at `/logout` and sign in again. The role is cached in the session at login. |
| `Error: listen EADDRINUSE` | Something else is using `PORT`. Pick another port, and update `OIDC_REDIRECT_URI` and the provider's redirect URI to match. |
