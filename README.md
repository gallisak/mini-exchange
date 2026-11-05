# Mini Exchange

A limit-order exchange built on the starter repository: price-time matching with one active owner
per instrument, failover between engine instances, exactly-once settlement into a double-entry
ledger, reconciliation, a live order book with sequence numbers and client resync, and a chaos test
that kills processes under load.

- [Run it](#run-it)
- [Architecture and data path](#architecture-and-data-path)
- [Order book consistency](#order-book-consistency)
- [Failover](#failover)
- [Exactly-once settlement and reconciliation](#exactly-once-settlement-and-reconciliation)
- [Real-time book and client resync](#real-time-book-and-client-resync)
- [Problems found in the starter](#problems-found-in-the-starter)
- [Chaos test](#chaos-test)
- [Why Redis](#why-redis)
- [Security and platform](#security-and-platform)
- [Tests and CI](#tests-and-ci)
- [Breaking changes](#breaking-changes)
- [Known limitations and what I would do differently](#known-limitations-and-what-i-would-do-differently)

## Run it

```bash
docker compose up -d --build        # or docker-compose up --build with the standalone Compose
```

| What | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Matching engine API (nginx in front of two engines), Swagger | http://localhost:3001, http://localhost:3001/docs |
| Settlement API, Swagger | http://localhost:3002, http://localhost:3002/docs |

Compose starts Postgres and Redis, runs the migrations of both databases, then two matching engines
behind nginx, settlement, the frontend and an nginx in front of it. Ports 3000, 3001 and 3002 must
be free, and they listen on `127.0.0.1` only. Postgres and Redis are not published at all: they have
no passwords, and the command stream trusts whoever can write to it, so only the containers reach
them. Use `docker compose exec exchange-db psql -U exchange` or `docker compose exec redis redis-cli`.

Register on http://localhost:3000/login; a new account starts with 100,000 USD and 1,000 of every
instrument (`ABC`, `DEF`, `XYZ`). To open the operations panel, register first, then make your
account an admin and sign in again:

```bash
docker compose exec matching-engine-1 node dist/tools/grant-admin.js you@example.com
docker compose exec matching-engine-1 node dist/tools/grant-admin.js --revoke you@example.com
```

Useful commands:

```bash
./scripts/smoke.sh                                    # end-to-end checks against the running stack
node e2e/browser-smoke.mjs                            # browser scenario (cd e2e && npm ci first; needs a fresh stack)
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build
node scripts/chaos/run.mjs                            # chaos test, writes chaos-report.md
docker compose exec settlement-service sh /opt/secrets/with-secrets.sh node dist/reconciliation/reconcile.js
docker compose exec matching-engine-1 node dist/tools/replay-check.js
docker compose logs -f matching-engine-1 settlement-service   # JSON logs with traceId
```

`browser-smoke.mjs` needs an empty `ABC` book. Run it before `smoke.sh`, or a minute after it:
`smoke.sh` uses up the sign-in limit of the address on purpose.

Every service has a `.env.example`. Compose loads those files and overrides only the hosts, the
instance ids, the instrument list and the service URLs in `docker-compose.yml`; secrets come
separately. On the first start a one-off `secrets` service generates random JWT secrets, the proxy
key and the internal keys of the engine and of settlement, one volume per service, and each service
mounts and loads only its own keys before it starts. The placeholders in `.env.example` are for
running a service outside compose. Secrets have no defaults in code: an engine refuses to start
without `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`. `docker compose down -v` drops these volumes,
so the next start issues new secrets and signs everyone out.

## Architecture and data path

```mermaid
flowchart LR
  B[Browser] --> W[nginx :3000] --> F[Next.js frontend<br/>httpOnly cookies, proxy]
  B -- WebSocket --> G
  F --> G[nginx :3001]
  G --> E1[engine-1]
  G --> E2[engine-2]
  E1 & E2 -- XADD command --> CS[(Redis stream<br/>orders:commands:ABC)]
  CS -- XREAD, owner only --> O[owner of ABC<br/>lease + fencing token]
  O -- one transaction:<br/>orders, trades, outbox,<br/>stream position --> PG[(Postgres: exchange)]
  O -- PUBLISH deltas, trades,<br/>order updates --> PS{{Redis pub/sub}}
  PS --> E1 & E2
  PG -- outbox relay --> TS[(Redis stream<br/>trades:ABC)]
  TS -- consumer group --> S[settlement-service]
  S -- one transaction:<br/>ledger + balances --> L[(Postgres: ledger)]
  S -- PUBLISH wallet change --> PS
```

The path of one order:

1. `POST /orders` on any engine validates the order, checks the `Idempotency-Key`, appends a
   command to `orders:commands:<instrument>` and answers `202 {orderId}`. Redis runs with
   `appendfsync always`, so a 202 means the command is on disk.
2. The owner of the instrument reads the stream in order and matches each batch in memory.
3. It commits the batch in one Postgres transaction: changed orders, trades, outbox rows and the id
   of the last applied command. The first statement checks its fencing token.
4. After the commit it publishes book deltas, trades and order updates through Redis pub/sub; every
   engine forwards them to its own WebSocket clients.
5. The outbox relay moves each trade to `trades:<instrument>`.
6. Settlement reads that stream through a consumer group and books the trade into the ledger in one
   transaction.
7. Settlement publishes the wallet change of both sides and only then acknowledges the event; the
   owner of each wallet gets a `wallet` event over WebSocket.

One trace id follows that path. The id comes from `x-request-id` or is generated, travels in the
command, the trade and the trade event, and every JSON log line on the way carries it. `smoke.sh`
greps one trace id out of the logs of both services:

```text
matching-engine-service  HTTP                POST /orders 202
matching-engine-service  BookRunner:ABC      Applied submit 4b9f… filled
matching-engine-service  BookRunner:ABC      Trade 77a4… executed 1.00000000 @ 10.00
matching-engine-service  OutboxRelayService  Published trade.executed 77a4… to trades:ABC
settlement-service       TradeConsumer…      Trade 77a4… settled from trades:ABC
```

## Order book consistency

**Single writer per instrument.** All orders of an instrument go through one Redis stream, and only
the instance that holds the instrument's lease reads it. Matching therefore happens in exactly one
place, in the order the commands sit in the stream. There is no lock around matching that would only
"mostly" serialise concurrent requests.

**What the broker guarantees.** A Redis stream assigns every entry a strictly increasing id at
`XADD`. The order of entries is the order in which Redis accepted the commands, which is the arrival
order the exchange commits to. Two requests that arrive "at the same time" are ordered by Redis, once,
and every replay sees the same order. Before `XADD` there is no order: two requests still travelling
through nginx and two different engines can reach Redis in either order, and the one Redis accepts
first is the one that arrived first. The `202` is sent only after `XADD`, so a client that waits for
it before sending its next order always gets them matched in its own order.

**Order of trade events.** Trades leave each instrument through its own stream, `trades:<instrument>`,
in the order the engine committed them: the outbox relay runs on one instance at a time (a Postgres
advisory lock) and publishes rows in id order. Settlement does not rely on that order, though. Every
posting only adds to or subtracts from a balance, so trades give the same balances in any order, and
an event reclaimed from a crashed consumer can safely be settled after newer ones.

**Determinism.** Time-priority uses a per-instrument `seq`, not wall clocks. An order's `createdAt`
and a trade's time come from the stream id, and trade ids are derived from the order id. Replaying a
stream from scratch therefore produces the same trades, ids and book. The concurrency test and the
chaos test both compare the stored state with such a replay.

**Exactly-once application.** The position in the stream is committed in the same transaction as the
orders and trades it produced. After a crash, a new owner resumes after the last committed command:
a committed command is never applied twice, an uncommitted one is applied once. The owner itself
works the same way after any failed batch: a commit can succeed even when the database answers with
an error, so it reloads the book and its position from Postgres and matches nothing until that
reload succeeds.

**Persistence.** The task allows periodic persistence. This implementation commits every batch,
which is stricter: the book in memory always equals the open orders in Postgres, so any instance can
rebuild it and answer snapshots from the database.

## Failover

| Setting | Value |
|---|---|
| Lease TTL (`LOCK_TTL_MS`) | 5 s |
| Renewal (`LOCK_RENEW_INTERVAL_MS`) | every 1.5 s |
| Acquisition attempts (`LOCK_ACQUIRE_INTERVAL_MS`) | every 1 s |

**Who detects a dead owner.** Nobody needs to: the owner keeps its lease alive by renewing it, and a
lease that is not renewed expires on its own. Every instance tries to acquire free instruments every
second. Acquire, renew and release are Lua scripts, so "check the holder and act" is atomic.

**Split brain.** A TTL alone does not stop an owner that froze, for example in a long GC pause or a
`docker pause`, and wakes up after someone else took over. Two mechanisms stop it:

- **Fencing token.** Acquiring increments a counter in Redis. The new owner raises
  `instrument_state.fence` to its token before it reads the book, and every commit starts with
  `UPDATE instrument_state … WHERE fence = <my token>`. A stale owner updates zero rows, rolls back
  and steps down. Nothing it computed reaches the database.
- **Local deadline.** Before each commit an owner checks that its own monotonic clock still gives
  the lease a safety margin of `max(TTL / 5, 200 ms)`, and stops when it does not. This keeps a
  slow owner from even trying in most cases; a commit that starts in time and runs past the lease
  is still stopped by the fencing token. An owner past its deadline also stops announcing its
  `seq`, so its clients do not see a heartbeat from an instance that no longer owns the book.

**Expected downtime of an instrument.**

| Event | Expected | Measured by the chaos test (three runs) |
|---|---|---|
| Owner killed (`kill -9`) | up to ~7 s: lease expiry ≤ 5 s, acquisition ≤ 1 s, loading the book | 5.5 s, 5.4 s, 5.3 s |
| Owner frozen past its lease | same as a kill, the zombie is rejected when it wakes | 6.2 s, 6.2 s, 6.6 s |
| Owner stopped gracefully (`SIGTERM`) | about 1 s: the owner finishes its batch, then releases its lease | 1.5 s, 1.4 s, 1.3 s |

During the downtime the API keeps accepting orders. They wait in the stream and the new owner
applies them in order, so no accepted order is lost or applied twice.

## Exactly-once settlement and reconciliation

**At-least-once delivery.** The engine writes each trade to an outbox table in the same transaction
as the trade. A relay copies outbox rows to `trades:<instrument>` and marks them published. A crash
between the two steps publishes the trade again, so the event may arrive more than once.

**Idempotent processing at the settlement boundary.** Settlement books a trade in one transaction:

1. Insert `ledger_transactions(reference = 'trade:<tradeId>')`, which has a unique index, with
   `ON CONFLICT DO NOTHING`. If the row already exists, this is a redelivery: the stored trade is
   compared with the event, and the event is either acknowledged as a duplicate or dead-lettered
   if the details differ.
2. Record the trade in `settled_trades`.
3. Post four double-entry lines: the buyer pays USD and receives the asset, the seller the
   opposite. Every asset sums to zero within the transaction.
4. Update the balances, always in sorted account order, so concurrent trades between the same
   users cannot deadlock.

The event is acknowledged (`XACK`) only after the commit and the wallet announcement. If settlement
dies between the commit and the acknowledgement, or cannot publish the announcement, another consumer
reclaims the event after `CONSUMER_RETRY_IDLE_MS`, step 1 sees the existing reference, the money does
not move again, and the wallets are announced again. Wallet events are therefore delivered at least
once. Malformed events and conflicting trade
ids go to `settlement:dead-letter`; any other failure is retried without a limit, so a database
outage never dead-letters a valid trade.

**Reconciliation** (`GET /admin/reconciliation` for admins, or `reconcile.js`) checks:

- every ledger transaction sums to zero per asset;
- every balance equals the sum of its entries, and every asset sums to zero across accounts;
- every trade has exactly four entries with the right owners, assets and signs;
- for every instrument, the engine's trade count, quantity and `Σ price × quantity` over the period
  equal the ledger's count, quantity and USD actually moved.

The result is `ok`, `mismatch` (with the offending rows) or `incomplete` when the engine is
unreachable. By default it skips the last minute, so trades still on their way are not reported as
missing.

### Indexes

Every query used for access checks and reconciliation has an index:

| Table | Index | Used by |
|---|---|---|
| `orders` | primary key `id` | cancel, which looks an order up by its id and owner |
| `orders` | `(ownerId, createdAt)`, `(ownerId, status)` | a user's own active and finished orders |
| `orders` | `(instrument, seq)` where open | loading a book, snapshots |
| `trades` | unique `(instrument, seq)`, `(executedAt)` | trade feed, engine totals for reconciliation |
| `outbox` | `(id)` where unpublished | the relay |
| `accounts` | unique `(ownerId, asset)` | a user's wallet, posting |
| `ledger_transactions` | unique `(reference)` | idempotent settlement |
| `ledger_entries` | `(transactionId)`, `(accountId)` | reconciliation of transactions and balances |
| `settled_trades` | primary key `tradeId`, `(executedAt)`, `(instrument, executedAt)` | redelivery check, reconciliation by period |

## Real-time book and client resync

- On `subscribe` a client gets `book_snapshot`: aggregated levels and the book's `seq`, read from
  Postgres in one REPEATABLE READ transaction. After that it gets `book_delta` messages with
  `seq + 1`, `seq + 2`, … containing only the levels that changed. A level with quantity zero has
  left the book.
- The owner announces the current `seq` every 2 s (`BOOK_HEARTBEAT_MS`) in `book_heartbeat`,
  together with that interval.
- `seq` lives in Postgres, so it does not restart on failover.

The client side is a pure reducer (`apps/frontend/lib/book/reducer.ts`, unit tested):

- deltas that arrive before the snapshot are buffered, and only those newer than the snapshot are
  applied;
- a gap in `seq`, a heartbeat that differs from the book's `seq`, or silence for longer than
  three heartbeat intervals (at least 7 s) mark the book **stale** and request a new snapshot.
  A heartbeat behind the book within 1 s of a snapshot is the one exception: it was sent just before
  the commit the snapshot already shows, so it is ignored, and the next one decides;
- a snapshot the client is no longer waiting for, older than the book it shows, is ignored, so a
  late reply cannot roll the book back;
- when an engine's own Redis subscription was down, it may have missed updates for its clients, so
  once it is subscribed again it sends every client `resync`. An owner that failed to publish an
  update does the same through every engine at its next successful publish, at the latest with its
  next heartbeat. The book asks for a snapshot, and orders, trades and the wallet reload;
- a requested snapshot that has not arrived after 5 s is requested again; when the engine answers
  `rate_limited`, the client retries after the time it was given and counts the 5 s from then;
- a lost connection shows **reconnecting**, and the book is replaced by a fresh snapshot after
  reconnecting.

The page shows `live`, `reconnecting` or `stale` and never keeps showing an old book as live. The
browser test forces a resync with a heartbeat ahead of the book and drops the WebSocket by stopping
nginx.

## Problems found in the starter

Each problem was first reproduced by a failing test in its own commit, then fixed in the commits
after it. The `proof/*` branches keep those commits with their CI runs, so the red run is visible
next to the fix.

| # | Problem | How it was confirmed | Fix | Proof |
|---|---|---|---|---|
| 1 | **Fake test.** `self-trade.spec.ts` only checked `expect(result).toBeTruthy()`, which passes whatever the matcher does. | Rewritten test fails against a matcher that lets an owner trade with itself | The test checks that no trade happens and that the next counterparty still trades | `proof/matcher-core` |
| 2 | **Concurrent orders on one book.** Matching ran inside request handlers on a shared in-memory book: orders arriving together were lost or double-filled, cancelled orders came back, a cancel naming another instrument left the order matchable, filled orders stayed open in the database, the book was lost on restart, and a retried request created a second order. | `starter-bugs.int-spec.ts`: one test per symptom, all failing before the fix | Command stream per instrument with a single writer, batch commits, required `Idempotency-Key` | `proof/command-log` |
| 3 | **IDOR on cancel.** `DELETE /orders/:id` cancelled any user's order. | "does not let a user cancel someone else's order" | Only the owner can cancel; another user's order gives 404, a finished one 409, a malformed id 400 | `proof/command-log` |
| 4 | **The lock.** It was not wired into order processing at all. It had no TTL, so a killed owner would hold its instrument forever. Release was a non-atomic `GET` then `DEL`, the service quit its Redis client before releasing on shutdown, and every replica would get the same `INSTANCE_ID` from `.env.example`. | `failover.int-spec.ts` and `ownership-identity.spec.ts` fail before the fix: a killed or stopped owner never hands over, processes share an identity | Lease with TTL and renewal in Lua, per-process identity, shutdown hooks, fencing token | `proof/ownership` |
| 5 | **Silent stale client.** Book messages had no sequence number, and `broadcastDepth` was never called, so a subscriber never saw updates. The book exposed order owners and required a token. | `realtime.int-spec.ts` fails before the fix | Snapshot and numbered deltas fanned out through Redis, public aggregated book, heartbeat, client resync | `proof/realtime` |
| 6 | **Floating-point money.** Prices and quantities were JS numbers: `0.001` became zero and large values lost digits. | `matcher-precision.spec.ts`, `order-validation.spec.ts` | Decimal strings in the API, BigInt fixed-point matching | `proof/matcher-core` |
| 7 | **Counterparty leak.** `POST /orders` returned trades with both user ids. | "returns only the order id and status, never trades or counterparties" | Returns `{orderId, status}` | `proof/matcher-core` |
| 8 | **Did not start cleanly.** A lint error broke the frontend build, `dist/main` was missing because tests were compiled into the build, an entity column had no type, and `synchronize: true` fails when two engines start together. | Compose smoke in CI | Fixes plus migrations run by a one-off `migrate` service | `proof/startup` |
| 9 | **Settlement not implemented.** | `settlement.int-spec.ts` fails before the fix | See settlement above | `proof/settlement` |
| 10 | **No rate limit, default secrets, open CORS.** | `platform.int-spec.ts` fails before the fix | Rate limits in Redis shared by instances, required secrets, CORS allow-list. Compose generates the secrets on first start (see below) | `proof/platform` |

### Found in a later review

These were not in the starter; they came up in reviews of the finished code. Where a test is named,
it fails without the fix.

| Problem | How it was confirmed | Fix |
|---|---|---|
| **An instrument could hang with no book running.** If renewing failed while a book was still loading (a slow database), the owner dropped the lease but the book started anyway. When the same instance acquired the instrument again, `startInstrument` kept the stale book, which was fenced out on its first command. The instance then held and renewed the lease with nothing processing the stream, so no other instance could take over. | `ownership-lifecycle.spec.ts`: "does not keep a book running after losing the lease while it was starting" | The owner stops a book that finished loading after the lease was lost, and a new token replaces a running book instead of being ignored |
| **The concurrency test compared the engine with itself.** It replayed the stream through the same `applyCommands`, so a matching bug would be reproduced by the replay. | Breaking the trade price, the time priority or self-trade prevention in the matcher still passed it | A separate, deliberately naive price-time reference. 40 random command streams in unit tests and the concurrent flow are checked against it, plus "no crossed book between different owners" |
| **A snapshot that never arrived left the book stale for good.** Nothing asked again after a lost reply, for example when the database failed during `subscribe`. | `reducer.test.ts` | The client asks again after 5 s without a snapshot |
| **The trade feed could skip trades and the order list could go back.** Trades that arrived while the list was loading were dropped, and gaps in the trade `seq` went unnoticed. A reload could replace a filled order with an older open version. | `feeds.test.ts` | Trades are buffered until the list loads and merged by id; a skipped `seq` reloads the list; an order only moves forward |
| **Two sign-ups with one email at once gave a 500**, and login skipped the hash check for unknown emails, so timing showed which emails had accounts. | `auth.int-spec.ts`, `auth-login.spec.ts` | 409 on the unique violation; a dummy hash is checked for unknown emails |
| **`/trades/summary` was public.** Anyone could make the engine total every trade in a period, 100 times a second. | `trade-summary.int-spec.ts` | It needs the engine's internal key, which reconciliation sends |
| **Compose ran with the published placeholder secrets** and exposed the APIs on every interface. Anyone who read the repository could sign a token for any user or as an admin, or pick their own address for the sign-in limit with the proxy key. | Reading `docker-compose.yml` and `.env.example` | Secrets generated per installation, ports on `127.0.0.1` |
| **The engine's unit tests failed in CI.** Jest took the reference matcher helper for a test file and failed with "Your test suite must contain at least one test", so `npm test` exited with 1 although every test passed. | `npm test` exits with 1 | Only `*.spec.ts` files run as unit tests |
| **Cancelling a partially filled order erased how much of it was filled.** A cancel set the remaining quantity to zero, so an order of 5 with 1 filled showed as "5 / 5 cancelled". | `apply-commands.spec.ts`: "keeps the filled part of a partially filled order it cancels", `cancel.int-spec.ts` | A cancel keeps the remaining quantity. A migration restores it for orders cancelled earlier from their trades |
| **The WebSocket silently went anonymous.** If the frontend could not issue a socket token three times in a row, for example while an engine restarted, the socket connected without one and the user stopped getting order and wallet updates without any sign of it. | `ws-token.test.ts`, `browser-smoke.mjs`: the buyer's socket token fails three times first | The socket keeps asking for a token with a backoff of up to 5 s and connects only with one |
| **The operations page reconciled the whole history every 5 s**, and the engine fetched up to 10,000 stream entries per instrument for each status just to count them. | `ops-polling.test.ts` | Reconciliation runs once a minute and on refresh; Redis counts the commands behind itself |
| **A service that rejected a valid session signed the user out.** Any 401 from a service cleared the cookies, even right after the engine had renewed the session, and the operations page turned a 401 from settlement into a sign-out. | `upstream.test.ts` | A 401 after a successful renewal answers 502 and keeps the session; only the engine can deny the operations page |
| **A stolen refresh token had 30 s to get past reuse detection.** The frontend handed the rotated pair to anyone who came with the old token within 30 s. | `session.test.ts` | The window is 5 s, enough for requests that raced the rotation |
| **The order form reused its Idempotency-Key for a different instrument.** After a failed attempt, switching the instrument and submitting again sent the same key and got a 422. | `order-attempt.test.ts` | The key belongs to the exact order: instrument, side, price and quantity |
| **nginx replayed sign-in and refresh requests.** `non_idempotent` let nginx resend a refresh that one engine had already received to the other engine after a timeout, which looked like a reused token and ended the session. | `scripts/test-gateway.sh` | `/auth/` is retried only when the request never reached an engine |
| **`POST /trades/settle` could never be used in compose**: its internal key was not generated. | `scripts/test-secrets.sh` | The key is generated with the other secrets |
| **Passwords longer than 72 bytes were cut by bcrypt**, so a longer password with the same first 72 bytes also signed in. | `auth-validation.spec.ts` | Sign-up and sign-in refuse passwords over 72 bytes |
| **A heartbeat slower than 7 s made every client resync all the time**, because the client's silence limit was fixed while `BOOK_HEARTBEAT_MS` was configurable. The frontend also had its own hard-coded instrument list. | `reducer.test.ts` | Each heartbeat carries its interval and the client waits for three missed ones; the instrument list is set once in compose |
| **The order list and the matcher did not scale.** `GET /orders` returned every order a user ever placed, and sorting the book parsed prices in every comparison. | `own-orders.int-spec.ts` | All active orders and the latest 100 finished ones (`ORDER_HISTORY_LIMIT`); prices are parsed once per sort |
| **Work that kept failing was retried out of sight.** A batch the engine could never commit stopped its instrument, and settlement retried a trade it could never book, with nothing but error logs to show for it. | `stuck-book.int-spec.ts`, settlement `ops.int-spec.ts` | `/ops/status` and the operations page mark such a book as stuck, with its failed batches and last error, and show trades that are being retried and how long the oldest has waited. `book_batch_failures_total` counts the failures. Nothing is skipped |
| **A rate-limited snapshot request made the book go stale.** The client kept counting the snapshot timeout while it waited to retry. | `reducer.test.ts` | The timeout counts from the retry |
| **Reconnecting reset the snapshot limit.** It was counted per socket. | `platform.int-spec.ts`: "keeps limiting a client that reconnects" | Also 60 per 10 s per client address, counted in Redis and shared by the engines |
| **Postgres and Redis were published on the host** without passwords, and the command stream trusts whoever writes to it, so any local process could place or cancel orders for any user. | Reading `docker-compose.yml` | They are reachable only from the containers |
| **The chaos test measured the load generator, and the secrets test only passed on macOS.** A takeover counted as finished at the next order from the load, which nginx partly sent to the frozen engine, so B failed on a slow CI runner with the new owner already working. The secrets test read the generated files from the host, which only works where Docker ignores file owners. | The `chaos` and `infrastructure` jobs failed in CI | A probe order sent straight to the new owner marks the end of a takeover; the secrets test runs on a Docker volume and also checks the files belong to the node user with mode 600 |
| **Updates missed before a late first connect were lost.** Orders, trades and the wallet reloaded only on a reconnect, so when the socket first connected late, for example while its token could not be issued, what happened meanwhile never showed up. | `browser-smoke.mjs`: the buyer's socket token fails three times first | They reload on every connect |
| **A book could match on state older than its last commit.** When a commit succeeded but the database answered with an error, the owner reloaded its state once and, if that reload failed too, went on with the book and counters from before the commit. It wrote smaller `orderSeq` and `tradeSeq` back, could match against orders that had already filled, and the next trade then hit the unique `(instrument, seq)` index for good. | `book-recovery.int-spec.ts` | After any failed batch the owner reloads from Postgres and matches nothing until the reload succeeds |
| **A graceful shutdown dropped the lease before the book stopped.** Both shutdown hooks ran at once, so the owner released the instrument while its last batch was still committing, and that batch was thrown away. | `ownership-shutdown.spec.ts` | The owner waits for its book to stop, with a valid lease, and releases the instrument after that |
| **A frozen owner kept announcing its `seq` when it woke up.** Its heartbeat came from a book it no longer owned. | `fencing.int-spec.ts`: "stops announcing its sequence number once its lease has expired" | No heartbeat past the lease deadline or before a reload |
| **Anyone could become an admin by registering an email from `ADMIN_EMAILS` first.** Emails are not verified. | `auth.int-spec.ts`: "does not make whoever registers an email from the configuration an admin" | The role lives with the account and only `grant-admin.js` changes it |
| **Updates lost while an engine's Redis subscription was down went unnoticed** by the order list, the trade feed and the wallet, which have no sequence numbers, while the socket to the browser stayed up. | `realtime-private.int-spec.ts`: "tells connected clients to reload once its Redis subscription was down" | Once it is subscribed again the engine sends `resync`; every page reloads and the book asks for a snapshot |
| **A late snapshot could roll the book back**, and a heartbeat behind the book went unnoticed. | `reducer.test.ts` | A snapshot older than the book is ignored unless one is awaited; any heartbeat that differs from the book makes it stale |
| **A form on another site could sign a visitor in** to the attacker's account, because sign-in read any body as JSON. | `auth-route.test.ts` | Sign-in and sign-up accept only `application/json` |
| **`replay-check` looked only at open orders**, so a filled order stored as cancelled passed. | `replay-check.int-spec.ts`: "notices a finished order stored with another outcome" | It compares the status and remaining quantity of every order |
| **`rate_limited` did not say which book it was about**, and listing own orders by status had no index. | `platform.int-spec.ts` | The notice names the instrument; index on `orders(ownerId, status)` |
| **A wallet announcement that failed was never sent.** Settlement logged the failure and acknowledged the trade, so the wallet page stayed behind until the next reconnect. | `trade-stream.int-spec.ts`: "announces a settled trade to both wallets even when the first announcement could not be published" | The consumer acknowledges only after the announcement; a redelivered trade is announced again |
| **An update the owner failed to publish went unnoticed** by clients whose socket and subscription stayed up. | `realtime-private.int-spec.ts`: "tells connected clients to reload after an update could not be published" | The next successful publish is followed by `resync` to every client |
| **A heartbeat that raced a snapshot made the book stale for nothing.** | `reducer.test.ts`: "stays live on a heartbeat sent just before the commit its snapshot already shows" | A heartbeat behind the book within 1 s of a snapshot is ignored; the next one decides |

## Chaos test

`scripts/chaos/run.mjs` runs against the compose stack (`docker-compose.chaos.yml` only raises rate
limits; the script makes its own admin with `grant-admin.js`) and runs in CI as the `chaos` job.

**Load.** Eight workers place orders for ten traders on all three instruments, about 150 a second,
priced so most of them trade. On a timeout, a 5xx or a 429 a worker retries with the same
`Idempotency-Key`, as a real client would.

**Scenarios**, one after another while the load runs:

| | Scenario |
|---|---|
| A | `kill -9` the engine that owns `ABC` |
| B | `docker pause` the owner of `DEF` for 8 s, longer than the lease, then resume it |
| C | `SIGTERM` the owner of `XYZ` |
| D | `kill -9` settlement for 5 s while trades keep coming |

**Checks after the load stops and every queue has drained:**

- every order that got a 202 is stored exactly once, and nothing else is stored;
- the engines applied every command in the streams;
- `replay-check` rebuilds every book from its stream: same trades, same open orders, and the same
  status and remaining quantity for every order;
- reconciliation is `ok` and the number of settled trades equals the number of trades;
- each takeover finished within its limit (10 s, 10 s, 3 s). A takeover counts as finished when a
  probe order, sent straight to the new owner's container so that nginx cannot route it to the
  frozen one, is committed;
- the resumed zombie in B stepped down instead of writing.

**Before the fixes** the starter could not run this test at all: settlement was not implemented, and
concurrent orders were lost (`proof/command-log`). Scenario A was reproduced on its own with the
starter lock wired in (`a376930` in `proof/ownership`) and two engines against the same Redis:

| | Observed |
|---|---|
| Owner `engine-a` running | `lock:instrument:ABC = engine-a`, `PTTL -1`: the lock never expires |
| 30 s after `kill -9 engine-a` | Still `engine-a`, `PTTL -1`; `engine-b` never logged that it owns `ABC` |
| A buy against a resting sell after the kill | Accepted but never matched: `failover.int-spec.ts` waited 15 s for `filled` and got nothing |
| `SIGTERM` instead of `kill -9` | The same: the order sent after the stop was never stored, the lock stayed with the stopped engine |

After the fixes the same test passes, and the chaos run below hands `ABC` over in about 5 s under
load.

**After the fixes**, three consecutive local runs:

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| A. `kill -9`: new owner / probe order committed | 5.1 s / 5.5 s | 4.9 s / 5.4 s | 4.9 s / 5.3 s |
| B. pause past the lease: new owner / probe order committed | 5.7 s / 6.2 s | 5.7 s / 6.2 s | 6.1 s / 6.6 s |
| C. `SIGTERM`: new owner / probe order committed | 1.1 s / 1.5 s | 1.0 s / 1.4 s | 0.8 s / 1.3 s |
| D. settlement settling again after its restart | 1.3 s | 1.2 s | 1.2 s |
| Orders accepted and stored exactly once | 9,759 | 9,524 | 8,972 |
| Replay, reconciliation, nothing left unapplied | pass | pass | pass |

The probe measures the instrument, not the load generator. Earlier the test waited for the next
order from the load instead, and in B nginx kept sending about half of those to the frozen instance,
where they waited for the client's timeout. On a slow CI runner that alone stretched B past its
limit while the new owner was already working. See the limitations below for that effect on
clients.

## Why Redis

Redis Streams is the order log and Redis is the coordinator.

- **Ordering.** A stream per instrument is a partition per instrument with a total order inside it,
  which is exactly what one order book needs. Kafka would give the same with more machinery to run.
  RabbitMQ does not give a replayable log.
- **Replay.** A stream keeps its entries, so a new owner resumes from a committed position and a
  checker can replay everything.
- **Consumer groups.** These give settlement at-least-once delivery with acknowledgements, a pending
  list and reclaiming, so no extra broker is needed.
- **Atomic locks.** Lua scripts make lease acquisition, renewal and release atomic. The fencing token
  closes the gap that a TTL lease alone leaves open. etcd or ZooKeeper would add consensus that
  Redis does not have, but the fencing check in Postgres makes correctness independent of that.
- **One dependency.** The same Redis also carries pub/sub for the book and the shared rate limits.

## Security and platform

- **Authentication.** JWT access tokens (15 min) and refresh tokens (7 days) that rotate on use.
  Reusing an old refresh token ends the session. Logout revokes the refresh token. The admin role
  is stored with the account and given or taken away only by an operator with `grant-admin.js`; it
  reaches the token at the next sign-in or refresh. Emails are not verified, so a role that came
  from the email alone would go to whoever registered that address first.
- **Frontend.** Tokens live only in httpOnly, `SameSite=lax` cookies, and the browser talks to
  Next.js route handlers that forward the token. Sign-in redirects only to paths inside the app.
  Sign-in and sign-up accept only a JSON body, which a form on another site cannot send, so such a
  form cannot sign the visitor into an attacker's account.
  The WebSocket handshake carries a short-lived access token, and the socket is closed when that
  token expires.
- **IDOR.** Orders and wallets are always looked up by the token's user. A WebSocket client cannot
  join another user's room.
- **Validation.** DTOs with whitelisting everywhere. Prices and quantities are decimal strings
  within column precision, only listed instruments are accepted, ids must be UUIDs.
- **Rate limits.** Shared by both engines through Redis:

  | Scope | Limit | Counted per |
  |---|---|---|
  | Orders | 20 / s | user |
  | Sign-in | 10 / min | address |
  | Public endpoints | 100 / s | address |
  | Book snapshots over WebSocket | 10 / 10 s | socket |
  | Book snapshots over WebSocket | 60 / 10 s | address |

  The nginx gateways overwrite `X-Forwarded-For` so a client cannot pick its own address. The
  frontend passes the user's address with a shared key. Sign-in and orders answer 503 rather than
  skipping the limit while Redis is down.
- **Secrets and internal calls.** Compose generates the secrets on first start, and each service
  sees only its own. The engine's trade summary, used by reconciliation, needs the engine's internal
  key, and settlement's `POST /trades/settle` needs settlement's.
  Unknown emails still cost a password-hash check at sign-in, so timing does not reveal accounts.
- **Observability.**
  - JSON logs with a trace id end to end.
  - Prometheus `/metrics` and `/health` on both services.
  - `/ops/status` for admins: owners, fences, stream backlog, books that are stuck, outbox,
    consumer lag, trades being retried, dead letters.
  - An operations page in the frontend for admins.
- **API docs.** Swagger at `/docs` on both services.

## Tests and CI

| Where | What |
|---|---|
| `apps/matching-engine-service/test` | Unit tests: matcher, precision, order and password validation, self-trade, depth, apply-commands, the order response, sign-in timing, ownership and its shutdown order, random command streams against an independent price-time reference |
| `apps/matching-engine-service/test/int` | Against real Postgres and Redis, including spawned engine processes: starter bugs, concurrency against a replay and the reference, cancelling, the own order list, fencing, a stuck book, a book recovering from a commit answered with an error, failover, real-time across instances, private updates and `resync`, auth and the admin tool, rate limits including snapshots per address, tracing, ops, replay check |
| `apps/settlement-service/test` | Unit tests: postings, idempotent handling of trade events; integration: redelivery, crash before `XACK`, concurrent trades, reconciliation, ops including retried trades |
| `apps/frontend/lib` | Book resync reducer, trade feed and order list merging, the socket token retry, the order form's key, the operations page polling, sharing a refresh and handling a service's 401, sign-in only as JSON, decimals, safe redirect |
| `scripts/smoke.sh` | The whole compose stack, from a trade to both wallets, reconciliation, one trace id, 429s, forged headers, docs |
| `e2e/browser-smoke.mjs` | Playwright: sign-up, live orders while the socket token fails at first, the book, a forced resync, a reconnect, the wallet, and every page reloading after the engines lose their Redis subscription |
| `scripts/chaos/run.mjs` | The chaos test above |
| `scripts/test-gateway.sh`, `scripts/test-secrets.sh` | nginx retries an order but not a sign-in an engine already received; every service gets its own secrets, kept across restarts |

CI runs lint, typecheck, unit tests and build for every service. It also runs both integration
suites against Postgres and Redis service containers, the gateway and secrets checks, the compose
smoke with the browser test, and the chaos test.

The starter came with two tests. `matcher.spec.ts` is unchanged and green. `self-trade.spec.ts` was
rewritten because it tested nothing (problem 1).

## Breaking changes

| Before | After | Why |
|---|---|---|
| `POST /orders` → 201 with trades | 202 with `{orderId, status}` | Orders go through the command stream; trades must not leak counterparties |
| `price`, `quantity` as numbers | Decimal strings, too many decimals gives 400 | No floating-point money |
| No idempotency | `Idempotency-Key` header required | A retried request must not create a second order |
| `DELETE /orders/:id?instrument=` → 200 | `DELETE /orders/:id` → 202; another user's order 404, a finished one 409 | IDOR and ghost orders |
| `GET /orders/book` with a token, raw orders | Public, aggregated levels with `seq`, no owners | Public depth per the task, no data leak |
| WebSocket `book` event | `book_snapshot`, `book_delta`, `book_heartbeat`, `trade`, and private `order` and `wallet` | Sequence numbers and resync |
| `POST /auth/login` → 201 | 200, plus `/auth/refresh` and `/auth/logout` | Sessions |
| Messages in Ukrainian | English | Language of the project |
| Frontend on port 3000 directly | nginx (`web`) on port 3000 in front of it | Trustworthy client address |
| A cancelled order had `remainingQuantity` 0 | It keeps the quantity that was not filled | Cancelling is in the remainder; the filled part stays visible |
| `GET /orders` returned every order | Every active order and the latest 100 finished ones | Bounded response |
| Any password length | At most 72 bytes | bcrypt compares only 72 bytes |
| `book_heartbeat` `{instrument, seq}` | `{instrument, seq, intervalMs}` | Clients derive their silence limit from it |
| Postgres on host port 5433, Redis on 6379, both on every interface | Not published | No passwords, and the command stream trusts its writers |
| `ADMIN_EMAILS` granted the admin role at sign-up and sign-in | The role is stored with the account and set with `grant-admin.js` | Emails are not verified |
| `/api/auth/login` and `/api/auth/register` took any body | JSON only, anything else gives 415 | Login CSRF |
| `rate_limited` `{event, retryAfterMs}` | `{event, instrument, retryAfterMs}`, plus a `resync` event | A client with several books retries the right one, and reloads after lost updates |

## Known limitations and what I would do differently

- **Redis is a single point of failure.** Losing Redis's disk loses commands that were accepted but
  not yet applied. A replicated log (Redis with a replica and `WAIT`, or Kafka) would close that.
- **No uneven-load balancing.** Instruments are not spread evenly, and one instance can end up
  owning all of them.
- **A frozen owner slows the API down.** nginx keeps sending about half the requests to the frozen
  instance until they time out (60 s at nginx, 3 s in the chaos client). A short read timeout for
  the REST API with a retry on the other engine would fix that. Retrying is safe because of the
  `Idempotency-Key`.
- **Streams are never trimmed.** This keeps a full replay possible; production would trim them
  after a snapshot.
- **No balance reservation.** Balances can go negative.
- **Crossed books within one user.** Self-trade prevention skips the user's own resting order, so
  a user's buy can rest above their own sell. Other users still trade against both.
- **Book contract for clients.** A `book_delta` may arrive before the `book_snapshot`; clients
  buffer and drop deltas with `seq` not above the snapshot.
- **The internal `POST /trades/settle` announces wallets best effort.** Trades from the stream are
  announced at least once, but this fallback endpoint answers its caller and does not retry a
  failed announcement. The client still reloads its wallet on every connect and `resync`.
- **A real heartbeat regression is noticed one interval later** within 1 s of a snapshot, because
  that heartbeat could also be one that raced the snapshot.
- **Sessions.**
  - An access token stays valid until it expires (15 min) after logout.
  - Two simultaneous refreshes with the same token end the session; the frontend serialises them
    and hands the new pair to requests with the old token for 5 s.
- **Rate limits.** They use fixed windows, so a burst of up to twice the limit is possible across a
  window boundary.
- **Email collisions.** An email that would collide with another account after lowercasing stays as
  it was and needs a manual merge.
- **Public endpoints.** `/metrics`, `/health` and `/docs` need no authentication.
- **A failure that repeats blocks instead of skipping.** A batch that the engine can never commit
  stops its instrument, and settlement retries a trade it can never book without a limit. Both are
  marked in `/ops/status` and on the operations page. Skipping would lose an accepted order or a
  trade, so a person has to look.
- **Order history.** `GET /orders` returns the latest 100 finished orders; older ones need paging,
  which is not built.
- **`replay-check`** compares only what the engine has applied, in one consistent snapshot, so it
  can run against a live system. Commands still waiting are reported separately.
