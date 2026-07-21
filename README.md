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

## D1

```bash
wrangler d1 execute starbud-db --local --file migrations/0001_initial.sql
```
