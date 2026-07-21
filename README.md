# Starbud Backend

Cloudflare Workers backend for Starbud.

## Scope

- Task API
- D1 database schema
- Child task records
- Device sync endpoint placeholders
- Durable Objects-ready boundary

All server-side logic belongs here. The parent web app and child desktop app should only call these APIs.

## Scripts

```bash
npm install
npm run dev
npm run deploy
```

## Cloudflare D1 SQLite

Create the remote D1 database:

```bash
npm run d1:create
```

Copy the returned `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "starbud"
database_id = "your-d1-database-id"
```

Apply migrations locally:

```bash
npm run d1:migrate:local
```

Apply migrations to Cloudflare:

```bash
npm run d1:migrate:remote
```

This creates the base tables and adds the default account columns. Configure the
initial password suffix as a Cloudflare secret before production use:

```bash
wrangler secret put INITIAL_PASSWORD_SUFFIX
```

The backend will seed these users automatically on login:

| Username | Password | Role |
| --- | --- | --- |
| `wangyamei` | username + configured suffix | Parent |
| `zhaotao` | username + configured suffix | Parent |
| `zhaoyouning` | username + configured suffix | Child |
| `zhaojianing` | username + configured suffix | Child |

Production should use a custom JWT secret:

```bash
wrangler secret put JWT_SECRET
```

Deploy Worker:

```bash
npm run deploy
```

## API

- `GET /health`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/children`
- `POST /api/tasks`
- `GET /api/tasks/today`
- `POST /api/tasks/:id/complete`
