# Julley Frontend

The React app. See the [main README](../README.md).

## Start

Start the [backend](../julley-backend/README.md) first, then in another terminal:

```bash
cd julley-frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server, forwarding `/api` and `/ws` to the backend |
| `npm run build` | Production build in `dist/` |
| `npm test` | Unit tests for the optimistic view and event replay |
| `npm run test:e2e` | Two real browsers; needs both projects installed, and Chrome or `E2E_CHANNEL=msedge` |
| `npm run lint` | ESLint |
