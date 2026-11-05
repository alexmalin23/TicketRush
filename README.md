# TicketRush

A high-concurrency ticket booking system that sells 10,000 seats to thousands of simultaneous buyers with zero overselling.

[![CI](https://github.com/alexmalin23/TicketRush/actions/workflows/ci.yml/badge.svg)](https://github.com/alexmalin23/TicketRush/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-22-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Highlights

- **Zero violations in every run.** 500 buyers for one seat: exactly 1 winner. No seat sold twice, no charge without a ticket.
- **1,542–1,562 requests per second at 2,000 users**, p99 111–142 ms, 0% failures, on one laptop that also runs the load generator.
- **98% fewer reads per request on the Postgres primary.** Postgres CPU from about 240% to 25%.
- **An expired cache key costs 30 queries in 30 s, not 1,150**, at 700 requests per second.
- **Survives a replica killed mid-sale.** Paid orders left without tickets: 3 before the reconciler, 0 after.
- **At 6,000 users, failures fall from 71–75% to 0–15%** with the waiting room, and issued orders rise from 361–804 to 1,303–1,468.

## Architecture

```mermaid
flowchart LR
    client["Client"] --> lb["nginx"]
    lb --> api["API x3"]
    api --> redis[("Redis: cache, queue, waiting room")]
    api --> pg[("Postgres primary")]
    pg -.-> replica[("Replica (optional)")]
    redis --> worker["Payment worker"]
    worker --> pg
    worker --> pay["Payment provider (mock)"]
```

## Booking flow

```mermaid
sequenceDiagram
    actor B as Buyer
    participant A as API
    participant R as Redis
    participant P as Postgres
    participant W as Worker
    participant C as Card provider

    rect rgba(128, 128, 128, 0.12)
    Note over B,C: 1. Log in
    B->>A: Log in with email and password
    A->>P: Check email and password
    A-->>B: Logged in, here is your login token
    end

    rect rgba(66, 133, 244, 0.12)
    Note over B,C: 2. Waiting room
    B->>A: Enter the waiting room
    A->>R: Save buyer position
    B->>A: Can I enter yet?
    A-->>B: Yes, here is your access token
    end

    rect rgba(52, 168, 83, 0.12)
    Note over B,C: 3. Reserve a seat
    B->>A: Reserve this seat (with access token)
    A->>P: Reserve only if the seat is available
    A-->>B: Reserved for 10 minutes
    end

    rect rgba(251, 188, 4, 0.12)
    Note over B,C: 4. Create the order
    B->>A: Buy the reserved seat
    A->>P: Save the order, not paid yet
    A->>R: Add payment to the queue
    A-->>B: Order received, payment in progress
    end

    rect rgba(234, 67, 53, 0.12)
    Note over B,C: 5. Payment (background process)
    R->>W: Worker picks up the payment
    W->>C: Charge the credit card
    C-->>W: Payment approved
    W->>P: Mark seat as sold and create the ticket
    end

    rect rgba(142, 68, 173, 0.12)
    Note over B,C: 6. Receive the ticket
    B->>A: Is my order paid?
    A-->>B: Yes, here is your ticket
    end
```

## Key engineering problems solved

**Overselling under concurrency.** A read followed by a write lets two buyers take one seat. Holding is one conditional `UPDATE`, or one Lua script with Redis holds. 500 buyers, one seat: 1 winner in every run.

**Stateless horizontal scaling.** In-memory state broke at three replicas: a limit of 5 became 15, and logout did not revoke. Limits and revocations moved to Redis, as atomic scripts. 5 allowed, on any replica.

**Hot inventory in Redis.** Holds in Redis work, with the sale still decided in Postgres so a lost Redis cannot oversell. It brought no throughput gain at this scale, so Postgres stays the default.

**Read scaling.** Availability and the seat map were 98% of requests. A one-second cache took Postgres from about 240% to 25% CPU. Read replicas are wired behind a flag and not in use: the cache removed the need.

**Cache stampede.** Each expiry sent every request to Postgres: 1,150 queries instead of 30, each slowed from 30 to 500 ms. One rebuilder takes a Redis lock while the rest get the stale answer: 30 queries, p99 from 1.9 s to under 70 ms.

**On-sale spikes.** 6,000 users took all replicas out of rotation. A waiting room admits a set rate with one Lua script per second, however many replicas run it. Failures from 71–75% to 0–15%.

**Exactly-once payment effects.** Queues deliver at least once. The provider key makes one charge, and guarded status moves make one sale: the same job run ten times at once gives 1 charge and 1 ticket. A reconciler finishes what a crash leaves behind.

## Evolution & benchmarks

| Stage | Bottleneck | Change | RPS at 2,000 users | p99 | Errors | Tag |
|---|---|---|---:|---:|---:|---|
| 1 | Races on seats | Atomic holds | 784 | n/a | 0% | `v1-monolith` |
| 2 | One process's CPU | 3 replicas, nginx | 967 | 1,596 ms | 0% | `v2-load-balancer` |
| 3 | State per process | Shared state in Redis | 1,104–1,154 | 769–1,069 ms | 0% | `v3-sessions` |
| 5 | Reads on the primary | Seat cache | 1,430–1,438 | 1,134–1,427 ms | 0% | `v5-cache` |
| 6 | Collapse at 6,000 users | Worker, waiting room | n/a | n/a | 0–15% at 6,000 | `v6-queue` |
| 7 | Finding bottlenecks by hand | Metrics, dashboard | 1,542–1,562 | 111–142 ms | 0% | `v7-final` |

All on one laptop under changing conditions, so differences between stages are indicative. There is no stage 4 tag: replicas were built as infrastructure only.

## Built on Modex

Modex is the in-house framework the service is built on: Express 5 and TypeScript with decorators, dependency injection and explicit wiring in one file. Why a custom lightweight framework: infrastructure is created in one place, so adding Redis or a worker changed that wiring point and the one feature using it. SQL stays explicit, so locks and isolation are visible in the code.

## Tech stack

| Piece | Why |
|---|---|
| Node 22, TypeScript | One process per replica, easy to scale out |
| Modex | Explicit wiring, no ORM between the code and its locks |
| Postgres 16 | Source of truth: sales, orders, payments, tickets |
| Redis 7 | Atomic scripts, TTLs, sorted sets for what may be lost |
| BullMQ | Retries and backoff, on the Redis already there |
| nginx | One entry point, least connections |
| k6 | Load scenarios named after what they prove |
| Prometheus, Grafana | Latency, pool, cache and queue per replica |

## Running locally

Needs Docker and Node.

```bash
docker compose --profile full --profile observability up -d --build
```

```bash
SEED_USERS=5000 DATABASE_URL=postgres://postgres:postgres@localhost:5432/modex npm run db:seed
```

```bash
npm run load -- onsale-spike --env VUS=2000
```

The API is on `localhost:3080`, Grafana on `localhost:3001`, Prometheus on `localhost:9090`. Other scenarios: `smoke`, `oversell`, `rate-limit-bypass`, `stampede`. The last needs `npm run db:seed -- large`.

Baselines stay reachable behind flags: `CACHE_ENABLED=false`, `ORDER_PROCESSING=sync`, `HOLD_STORE=redis`, `RATE_LIMIT_STORE=memory`, `WAITING_ROOM_ENABLED=true` for the room.

## API overview

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/auth/login` | Login |
| `GET /api/v1/events/:id/availability` | Counts per section |
| `GET /api/v1/events/:id/seats?section=A` | Seat map |
| `POST`, `GET /api/v1/events/:id/queue` | Waiting room |
| `POST /api/v1/events/:id/holds` | Hold seats |
| `POST /api/v1/orders` | Place an order: 202, with `Idempotency-Key` |
| `GET /api/v1/orders/:id` | Order status |
| `GET /api/v1/orders/:id/tickets` | Tickets |

Full reference: the [Postman collection](postman/TicketRush.postman_collection.json).

## Design decisions

- **Holds are one conditional `UPDATE`,** never a read followed by a write.
- **The charge runs outside any transaction,** so a slow provider cannot hold row locks or connections.
- **Idempotency keys live in Postgres,** with the orders they protect.
- **The sale is always decided in Postgres.** Redis may lose what it holds; nothing sold depends on it.
- **Tickets are issued in the sale's transaction,** so "paid but no ticket" is never visible. Only payments are queued.
- **A job out of attempts keeps its seats,** because the charge may have happened. The reconciler keeps asking the provider.
- **A stale seat map is accepted, up to about 2.1 s,** since the hold checks the real state.
