# Starbud Backend

Cloudflare Workers backend for Starbud.

## Scope

- Task API
- D1 database schema
- Child task records
- Child task claiming and homework photo submissions
- Private homework photo storage in Cloudflare R2
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

Migration files are maintained in the private parent repository at
`../migrations/`. Run the migration commands below from this backend directory
inside the root `starbud-design` checkout.

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

Apply migrations locally. Use the npm script so repeat runs skip existing
columns safely:

```bash
npm run d1:migrate:local
```

Apply migrations to Cloudflare. Do not call `wrangler d1 migrations apply`
directly for this project; SQLite/D1 cannot make `ALTER TABLE ADD COLUMN`
idempotent in plain SQL, so the script checks schema first.

```bash
npm run d1:migrate:remote
```

Create the R2 bucket used for homework photos before the first deployment:

```bash
npx wrangler r2 bucket create starbud-submissions
```

The bucket is private. The API returns opaque, tokenized photo URLs rather than
exposing a public R2 endpoint.

This creates the base tables and adds the default account columns. Configure the
initial password suffix as a Cloudflare secret before production use:

```bash
wrangler secret put INITIAL_PASSWORD_SUFFIX
```

The backend will seed these users automatically on login:

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin@2026` (or `ADMIN_INITIAL_PASSWORD`) | Admin |
| `wangyamei` | username + configured suffix | Parent |
| `zhaotao` | username + configured suffix | Parent |
| `zhaoyouning` | username + configured suffix | Child |
| `zhaojianing` | username + configured suffix | Child |

Production should use a custom JWT secret:

```bash
wrangler secret put JWT_SECRET
```

Configure the AI provider key as an encrypted Worker Secret. Never place the
key in `wrangler.toml`, frontend environment variables, mini-program code or the
desktop app:

```bash
npx wrangler secret put OPENAI_API_KEY
```

All server-side AI features use the centralized client in
`src/services/ai.ts`. The production defaults are configured in
`wrangler.toml`: provider `OpenAI`, model `gpt-5.5`, Responses API and `xhigh`
reasoning. Every request sets `store: false`. `AI_RESPONSES_PATH` is separately
configurable because OpenAI-compatible gateways do not always expose the same
URL prefix.

`JWT_SECRET` is required and must contain at least 32 characters. The Worker
fails closed when it is missing or too short.

Create the administrator by setting its initial password before the first
deployment:

```bash
wrangler secret put ADMIN_INITIAL_PASSWORD
```

Demo family accounts are disabled by default. Enable them only for local
development by copying `.dev.vars.example` to `.dev.vars`. Do not enable
`SEED_DEMO_USERS` in production.

Deploy Worker:

```bash
npm run deploy
```

`npm run deploy` checks the Worker's encrypted Secret list before deployment.
When `JWT_SECRET` is missing, it generates a 48-byte random value in a
permission-restricted temporary file and uploads it with the same Worker
version. Existing secrets are preserved, so routine deployments do not
invalidate active sessions. The deployment identity needs permission to read
and edit Worker secrets.

## API

- `GET /health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/children`
- `GET /api/families`
- `POST /api/families`
- `PATCH /api/families/:id`
- `DELETE /api/families/:id` (creator only; the default family is protected)
- `POST /api/families/:id/members`
- `POST /api/families/:id/children`
- `PATCH /api/families/:id/members/:userId`
- `DELETE /api/families/:id/members/:userId`
- `POST /api/tasks`
- `GET /api/tasks/today`
- `GET /api/tasks` (filterable task list)
- `POST /api/tasks/:id/complete`
- `POST /api/tasks/:id/claim` (child)
- `POST /api/tasks/:id/submissions` (child)
- `DELETE /api/tasks/:id` (parent or admin)
- `GET /api/submissions` (child submission history)
- `POST /api/submissions/:id/photos` (multipart field: `photo`)
- `POST /api/submissions/:id/submit`
- `GET /api/submission-files/:id?token=...`
- `GET /api/admin/users` (admin only)
- `POST /api/admin/users` (admin only)
- `PATCH /api/admin/users/:id` (admin only)
