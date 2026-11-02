# Benchmarks

Measured, so the scalability claims in the README can be checked. Reproduce with `npm run bench` in
`julley-backend`. It uses a throwaway database.

## Setup

- **Machine:** one laptop, Intel Core i7-8665U (4 cores, 8 threads), 16 GB RAM, Windows 11.
- **Stack:** one Node process and one PostgreSQL 18 with default settings, on the same machine.
- **Load:** 32 concurrent HTTP clients and 3,000 card moves per scenario. Each move goes through the full
  path: JWT check, access check, row-level security, column and task locks, rank key, event log, `NOTIFY`.

The load generator runs **inside the server's Node process**, competing with it for one event loop, on a
machine that is also running the database. So read these as a conservative floor for a single node, and
compare the rows with each other more than as absolute limits.

## Write load

| Scenario | Moves per second | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| 1 tenant | 106 | 294 ms | 399 ms | 648 ms | 0 |
| 8 tenants | 142 | 219 ms | 300 ms | 337 ms | 0 |

**What this shows:**

- No request failed under contention, and no deadlocks surfaced.
- The per-tenant event counter has a visible but modest cost. Spreading the same load across 8 tenants
  gained about a third more throughput and cut p99 by about half. Writes in one tenant serialize at the end
  of their transaction, as designed.
- The limit here is mostly this machine's CPU, not that lock. If the lock dominated, 8 tenants would gain
  far more than a third. Separating the two would need the load generator on its own machine.

**For scale:** a busy branch of 50 people each making one change a minute produces under 1 write per
second, about 100 times below what one tenant sustained here.

## Fan-out

Time from sending a write until a subscribed socket has the event. It includes the HTTP request, the commit,
`NOTIFY`, reading the log and the socket send.

| Subscribers in the tenant | p50 | p95 | p99 |
|---|---|---|---|
| 1 | 15 ms | 23 ms | 27 ms |
| 50 | 20 ms | 26 ms | 30 ms |
| 200 | 28 ms | 38 ms | 291 ms |

Typical latency barely moves with the number of subscribers. The 200-subscriber p99 is a tail worth
noting: in this test, those 200 sockets and their test handlers all share one process with the server.

## Not measured

- Multiple Node instances under load. Delivery across two nodes is tested for correctness, not speed.
- A real network, or a separate database server.
- Long-duration behaviour, such as an `activity_logs` table with millions of rows.
- The sustained write rate at which the shared `NOTIFY` queue becomes the bottleneck.
