import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const ENGINE_URL = process.env.ENGINE_URL ?? 'http://localhost:3001';
const SETTLEMENT_URL = process.env.SETTLEMENT_URL ?? 'http://localhost:3002';
const COMPOSE = (process.env.COMPOSE ?? 'docker compose -f docker-compose.yml -f docker-compose.chaos.yml').split(/\s+/);
const REPORT = process.env.CHAOS_REPORT ?? 'chaos-report.md';
const TRADERS = Number(process.env.CHAOS_TRADERS ?? 10);
const WORKERS = Number(process.env.CHAOS_WORKERS ?? 8);
const LOCK_TTL_MS = 5_000;
const LIMITS = {
  kill: Number(process.env.CHAOS_LIMIT_KILL_MS ?? 10_000),
  pause: Number(process.env.CHAOS_LIMIT_PAUSE_MS ?? 10_000),
  sigterm: Number(process.env.CHAOS_LIMIT_SIGTERM_MS ?? 3_000),
};
const INSTRUMENTS = ['ABC', 'DEF', 'XYZ'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`, ...parts);

function compose(...args) {
  return execFileSync(COMPOSE[0], [...COMPOSE.slice(1), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function psql(sql) {
  return compose('exec', '-T', 'exchange-db', 'psql', '-U', 'exchange', '-d', 'exchange', '-tAc', sql).trim();
}

async function http(url, init = {}, timeoutMs = 3_000) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function until(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await condition();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(200);
  }
}

async function register(email) {
  const { status, body } = await http(`${ENGINE_URL}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ email, password: 'password123' }),
  });
  if (status !== 201) throw new Error(`Could not register ${email}: ${status}`);
  return body.accessToken;
}

const accepted = new Map();
const uncertain = [];
const stats = { requests: 0, retries: 0, failedAttempts: 0 };
let loadRunning = false;

async function submitOnce(token, order, key) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    stats.requests += 1;
    if (attempt > 0) stats.retries += 1;
    try {
      const { status, body } = await http(`${ENGINE_URL}/orders`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
        body: JSON.stringify(order),
      });
      if (status === 202) return body.orderId;
      if (status < 500 && status !== 429) throw new Error(`Order rejected with ${status}`);
    } catch (error) {
      if (String(error.message).startsWith('Order rejected')) throw error;
    }
    stats.failedAttempts += 1;
    await sleep(Math.min(250 * (attempt + 1), 1_000));
  }
  return null;
}

function randomOrder() {
  const side = Math.random() < 0.5 ? 'buy' : 'sell';
  const price = (99 + Math.floor(Math.random() * 3)).toFixed(2);
  const quantity = (1 + Math.floor(Math.random() * 3)).toString();
  return { instrument: INSTRUMENTS[Math.floor(Math.random() * INSTRUMENTS.length)], side, price, quantity };
}

async function worker(tokens) {
  while (loadRunning) {
    const token = tokens[Math.floor(Math.random() * tokens.length)];
    const order = randomOrder();
    const key = randomUUID();
    const orderId = await submitOnce(token, order, key);
    if (orderId) accepted.set(orderId, key);
    else uncertain.push({ token, order, key });
    await sleep(15);
  }
}

let admin;
async function opsStatus() {
  const { status, body } = await http(`${ENGINE_URL}/ops/status`, {
    headers: { authorization: `Bearer ${admin}` },
  }, 1_500);
  if (status !== 200) throw new Error(`ops status ${status}`);
  return Object.fromEntries(body.instruments.map((row) => [row.instrument, row]));
}

const serviceOf = (owner) => (owner?.startsWith('engine-2') ? 'matching-engine-2' : 'matching-engine-1');

async function measureTakeover(instrument, previousOwner, limitMs, disrupt) {
  const disruptedAt = Date.now();
  disrupt();
  const takenOver = await until(async () => {
    const row = (await opsStatus())[instrument];
    return row.owner && row.owner !== previousOwner ? row : null;
  }, 30_000, `a new owner of ${instrument}`);
  const owner = takenOver.owner;
  const ownerAfterMs = Date.now() - disruptedAt;
  await until(async () => {
    const row = (await opsStatus())[instrument];
    return row.lastCommandId !== takenOver.lastCommandId && row.owner === owner;
  }, 30_000, `${instrument} to process commands again`);
  const resumedAfterMs = Date.now() - disruptedAt;
  return { instrument, from: previousOwner, to: owner, ownerAfterMs, resumedAfterMs, limitMs, ok: resumedAfterMs <= limitMs };
}

async function waitHealthy(service) {
  await until(() => {
    const state = compose('ps', '--format', '{{.State}}', service).trim();
    return state === 'running';
  }, 60_000, `${service} to run`);
  await sleep(2_000);
}

async function scenarioKill() {
  const row = (await opsStatus()).ABC;
  const victim = serviceOf(row.owner);
  log(`A. kill -9 ${victim}, owner of ABC`);
  const result = await measureTakeover('ABC', row.owner, LIMITS.kill, () => compose('kill', '-s', 'KILL', victim));
  compose('start', victim);
  await waitHealthy(victim);
  return { name: 'A. kill -9 the owner under load', ...result };
}

async function scenarioPause() {
  const row = (await opsStatus()).DEF;
  const victim = serviceOf(row.owner);
  log(`B. pause ${victim}, owner of DEF, for ${LOCK_TTL_MS + 3_000} ms`);
  const result = await measureTakeover('DEF', row.owner, LIMITS.pause, () => compose('pause', victim));
  const remaining = LOCK_TTL_MS + 3_000 - result.resumedAfterMs;
  if (remaining > 0) await sleep(remaining);
  const resumedAt = new Date().toISOString();
  compose('unpause', victim);
  const zombie = await until(() => {
    const logs = compose('logs', '--no-color', '--since', resumedAt, victim);
    return /lost ownership of DEF|Fenced out of DEF/.test(logs) ? 'stepped down' : null;
  }, 20_000, `${victim} to step down from DEF`);
  return { name: 'B. pause the owner past its lease, then resume it', ...result, zombie };
}

async function scenarioSigterm() {
  const row = (await opsStatus()).XYZ;
  const victim = serviceOf(row.owner);
  log(`C. SIGTERM ${victim}, owner of XYZ`);
  const result = await measureTakeover('XYZ', row.owner, LIMITS.sigterm, () =>
    execFileSync(COMPOSE[0], [...COMPOSE.slice(1), 'kill', '-s', 'TERM', victim], { stdio: 'ignore' }),
  );
  await until(() => compose('ps', '--format', '{{.State}}', victim).trim() !== 'running', 20_000, `${victim} to exit`);
  compose('start', victim);
  await waitHealthy(victim);
  return { name: 'C. SIGTERM the owner', ...result };
}

function settledTrades() {
  return Number(
    compose('exec', '-T', 'exchange-db', 'psql', '-U', 'exchange', '-d', 'ledger', '-tAc', 'SELECT count(*) FROM settled_trades').trim(),
  );
}

async function scenarioSettlement() {
  const downMs = 5_000;
  log(`D. kill -9 settlement-service for ${downMs} ms while trades keep coming`);
  compose('kill', '-s', 'KILL', 'settlement-service');
  await sleep(downMs);
  const settledBefore = settledTrades();
  const backlog = Number(psql('SELECT count(*) FROM trades')) - settledBefore;
  compose('start', 'settlement-service');
  const restartedAt = Date.now();
  await until(() => settledTrades() > settledBefore, 60_000, 'settlement to settle again after its crash');
  return {
    name: 'D. kill -9 settlement while it works',
    downMs,
    backlog,
    resumedAfterMs: Date.now() - restartedAt,
  };
}

async function drain() {
  await until(async () => {
    const auth = { headers: { authorization: `Bearer ${admin}` } };
    const engine = await http(`${ENGINE_URL}/ops/status`, auth);
    const settlement = await http(`${SETTLEMENT_URL}/ops/status`, auth);
    return (
      engine.body.instruments.every((row) => row.commandsBehind === 0 && row.owner) &&
      engine.body.outboxPending === 0 &&
      settlement.body.streams.every((stream) => stream.pending === 0 && stream.lag === 0)
    );
  }, 120_000, 'every queue to drain');
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

async function main() {
  await until(async () => (await http(`${ENGINE_URL}/health`)).status === 200, 120_000, 'the engine');
  await until(async () => (await http(`${SETTLEMENT_URL}/health`)).status === 200, 120_000, 'settlement');
  const run = Date.now();
  admin = await register('chaos-admin@example.com').catch(async () => {
    const { body } = await http(`${ENGINE_URL}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: 'chaos-admin@example.com', password: 'password123' }),
    });
    return body.accessToken;
  });
  const tokens = await Promise.all(
    Array.from({ length: TRADERS }, (_, i) => register(`chaos-${run}-${i}@example.com`)),
  );
  const owners = psql(`SELECT string_agg(id::text, ',') FROM users WHERE email LIKE 'chaos-${run}-%'`).split(',');

  log(`load: ${WORKERS} workers, ${TRADERS} traders`);
  loadRunning = true;
  const workers = Array.from({ length: WORKERS }, () => worker(tokens));
  await sleep(5_000);

  const scenarios = [];
  for (const scenario of [scenarioKill, scenarioPause, scenarioSigterm, scenarioSettlement]) {
    scenarios.push(await scenario());
    log('   ', JSON.stringify(scenarios[scenarios.length - 1]));
    await sleep(4_000);
  }

  loadRunning = false;
  await Promise.all(workers);
  log(`load stopped: ${accepted.size} accepted, ${uncertain.length} without an answer, ${stats.retries} retries`);
  for (const { token, order, key } of uncertain.splice(0)) {
    const orderId = await submitOnce(token, order, key);
    if (!orderId) throw new Error(`Order ${key} never got an answer`);
    accepted.set(orderId, key);
  }
  await drain();
  log('queues drained');

  const stored = psql(
    `SELECT string_agg(id::text, ',') FROM orders WHERE "ownerId" IN (${owners.map((id) => `'${id}'`).join(',')})`,
  ).split(',').filter(Boolean);
  const storedSet = new Set(stored);
  const missing = [...accepted.keys()].filter((id) => !storedSet.has(id));
  const unexpected = stored.filter((id) => !accepted.has(id));
  const replayOutput = (() => {
    try {
      return { code: 0, text: compose('exec', '-T', 'matching-engine-1', 'node', 'dist/tools/replay-check.js') };
    } catch (error) {
      return { code: error.status, text: String(error.stdout) };
    }
  })();
  const replay = JSON.parse(replayOutput.text);
  const reconcileOutput = (() => {
    try {
      return compose('exec', '-T', '-e', 'RECONCILIATION_LAG_MS=0', 'settlement-service', 'sh', '/opt/secrets/with-secrets.sh', 'node', 'dist/reconciliation/reconcile.js');
    } catch (error) {
      return String(error.stdout);
    }
  })();
  const reconciliation = JSON.parse(reconcileOutput);
  const trades = Number(psql('SELECT count(*) FROM trades'));
  const settled = reconciliation.instruments.reduce((sum, row) => sum + row.ledger.count, 0);

  const checks = [
    check('every 202 is stored exactly once', missing.length === 0 && stored.length === accepted.size,
      `${accepted.size} accepted, ${stored.length} stored, ${missing.length} missing`),
    check('nothing is stored that was never accepted', unexpected.length === 0, `${unexpected.length} unexpected`),
    check('the engines applied every accepted command', replay.instruments.every((row) => row.pendingCommands === 0),
      replay.instruments.map((row) => `${row.instrument}: ${row.pendingCommands} left`).join(' · ')),
    check('an offline replay of the command streams gives the same trades and books', replay.matches,
      replay.instruments.map((row) => `${row.instrument}: ${row.commands} commands, ${row.trades} trades${row.problems.length ? `, ${row.problems.join('; ')}` : ''}`).join(' · ')),
    check('reconciliation matches and every trade settled once', reconciliation.status === 'ok' && settled === trades,
      `${reconciliation.status}, ${trades} trades, ${settled} settled`),
    ...scenarios.filter((s) => s.limitMs).map((s) =>
      check(`${s.name}: resumed within ${s.limitMs / 1000} s`, s.ok, `new owner after ${(s.ownerAfterMs / 1000).toFixed(1)} s, processing again after ${(s.resumedAfterMs / 1000).toFixed(1)} s`)),
    ...scenarios.filter((s) => s.zombie).map((s) => check('the resumed zombie stepped down instead of writing', s.zombie === 'stepped down', s.zombie)),
  ];

  const ok = checks.every((item) => item.ok);
  const report = [
    `# Chaos run ${new Date(run).toISOString()}`,
    '',
    `Load: ${WORKERS} workers over ${TRADERS} traders on ${INSTRUMENTS.join(', ')} for ${((Date.now() - run) / 1000).toFixed(0)} s, ${stats.requests} requests, ${stats.retries} client retries with the same Idempotency-Key.`,
    '',
    '| Scenario | Instrument | Owner moved after | Processing again after | Limit |',
    '|---|---|---|---|---|',
    ...scenarios.filter((s) => s.limitMs).map((s) => `| ${s.name} | ${s.instrument} | ${(s.ownerAfterMs / 1000).toFixed(1)} s | ${(s.resumedAfterMs / 1000).toFixed(1)} s | ${s.limitMs / 1000} s |`),
    '',
    ...scenarios.filter((s) => s.downMs).map((s) => `${s.name}: down for ${s.downMs / 1000} s with ${s.backlog} trades waiting; it settled again ${(s.resumedAfterMs / 1000).toFixed(1)} s after the restart and worked the backlog off once the load stopped.`),
    '',
    '| Check | Result | Detail |',
    '|---|---|---|',
    ...checks.map((item) => `| ${item.name} | ${item.ok ? 'pass' : 'FAIL'} | ${item.detail} |`),
    '',
  ].join('\n');
  writeFileSync(REPORT, report);
  console.log(`\n${report}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`CHAOS RUN FAILED: ${error.message}`);
  process.exit(1);
});
