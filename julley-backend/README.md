# Julley Backend

REST API, WebSocket server and database schema. See the [main README](../README.md).

## Start

```bash
cd julley-backend
npm install
npm start
```

`npm start` runs the API on port 4000 under nodemon, so saving a file restarts it. It also starts a local
PostgreSQL from npm, seeded with demo data. No database install is needed.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Local PostgreSQL, plus the API under nodemon |
| `npm run api` | The API under nodemon, for when you run PostgreSQL yourself |
| `npm run start:prod` | The API with plain Node, no file watching |
| `npm run simulate` | Bot teammates working on a real board, to watch in the browser |
| `npm run bench` | Measure throughput and latency against a throwaway database |
| `npm test` | Integration tests against real PostgreSQL |
| `npm run db:migrate`, `npm run db:seed` | Apply the schema; add demo data to an empty database |
| `npm run lint` | ESLint |

To start again with fresh demo data, stop the server and delete `.pgdata`.
