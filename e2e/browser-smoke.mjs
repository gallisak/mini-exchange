import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const COMPOSE = (process.env.COMPOSE ?? 'docker compose').split(/\s+/);
const SHOTS = process.env.SCREENSHOTS;
const started = Date.now();
const log = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);
const compose = (...args) => execFileSync(COMPOSE[0], [...COMPOSE.slice(1), ...args], { stdio: 'pipe' }).toString();

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function register(page, email, next = '') {
  await page.goto(`${BASE}/login${next}`);
  await registerHere(page, email);
}

async function registerHere(page, email) {
  await page.getByRole('tab', { name: 'Register' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/orders');
}

async function placeOrder(page, side, price, quantity) {
  await page.getByRole('tab', { name: side === 'buy' ? 'Buy' : 'Sell', exact: true }).click();
  await page.getByLabel('Price (USD)').fill(price);
  await page.getByLabel(/Quantity/).fill(quantity);
  await page.getByRole('button', { name: new RegExp(`^${side === 'buy' ? 'Buy' : 'Sell'} ABC$`) }).click();
  await page.getByText(/accepted/).first().waitFor();
}

async function waitStatus(page, status, timeout = 15_000) {
  await page.locator(`[data-status="${status}"]`).waitFor({ timeout });
  log(`book is ${status}`);
}

async function loadedBook() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const answer = await fetch(`${BASE}/api/market/book?instrument=ABC`)
      .then((response) => response.json())
      .catch(() => null);
    if (Array.isArray(answer?.bids) && Array.isArray(answer?.asks)) return answer;
    if (Date.now() > deadline) throw new Error(`The ABC book never loaded: ${JSON.stringify(answer)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const book = await loadedBook();
if (book.bids.length > 0 || book.asks.length > 0) {
  console.error('BROWSER SMOKE NEEDS A FRESH STACK: the ABC book already has orders that would match ours');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const run = Date.now();
  const seller = await (await browser.newContext()).newPage();
  const buyerContext = await browser.newContext();
  let tokenFailures = 0;
  await buyerContext.route('**/api/ws-token', (route) =>
    tokenFailures++ < 3 ? route.fulfill({ status: 503, body: '{}' }) : route.continue(),
  );
  const buyer = await buyerContext.newPage();

  await register(seller, `browser-seller-${run}@example.com`, '?next=//example.com');
  log('signed up, and a sign-in link to another site still landed on', new URL(seller.url()).pathname);
  await register(buyer, `browser-buyer-${run}@example.com`);

  await placeOrder(seller, 'sell', '20.00', '3');
  await seller.getByTestId('order-row').first().getByText('open').waitFor();
  await placeOrder(buyer, 'buy', '20.00', '1');
  await seller.getByTestId('order-row').first().getByText('partially filled').waitFor({ timeout: 10_000 });
  log("the seller's order turned partially filled without a reload");
  await buyer.getByRole('tab', { name: 'Filled & cancelled' }).click();
  await buyer.getByTestId('order-row').first().getByText('filled', { exact: true }).waitFor({ timeout: 20_000 });
  await buyer.getByRole('tab', { name: 'Active' }).click();
  await placeOrder(buyer, 'buy', '1.00', '1');
  await buyer.getByTestId('order-row').first().getByText('open', { exact: true }).waitFor({ timeout: 10_000 });
  log('the buyer still got live order updates after 3 failed socket token requests');

  const pickInstrument = async (page, name) => {
    await page.getByRole('combobox', { name: 'Instrument' }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await page.getByText(`Quantity (${name})`).waitFor();
  };
  const ordersApi = (request) => new URL(request.url()).pathname === '/api/orders' && request.method() === 'POST';
  await pickInstrument(buyer, 'DEF');
  await buyer.route('**/api/orders', (route) => (ordersApi(route.request()) ? route.abort() : route.continue()));
  await buyer.getByLabel('Price (USD)').fill('2.00');
  await buyer.getByLabel(/Quantity/).fill('1');
  await buyer.getByRole('button', { name: /^Buy DEF$/ }).click();
  await buyer.getByText(/may have been placed/).waitFor();
  await buyer.unroute('**/api/orders');
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await buyer.route('**/api/orders', async (route) => {
    if (ordersApi(route.request())) await held;
    await route.continue();
  });
  await pickInstrument(buyer, 'ABC');
  await buyer.getByLabel('Price (USD)').fill('1.00');
  await buyer.getByLabel(/Quantity/).fill('1');
  await buyer.getByRole('button', { name: /^Buy ABC$/ }).click();
  await buyer.waitForTimeout(300);
  await pickInstrument(buyer, 'DEF');
  release();
  await buyer.getByText(/ABC @ 1.00 accepted/).waitFor();
  await buyer.unroute('**/api/orders');
  await buyer.waitForTimeout(500);
  if (!(await buyer.getByText(/may have been placed/).isVisible())) {
    throw new Error('an order answered for ABC made the form forget the unconfirmed DEF order');
  }
  await buyer.getByRole('button', { name: 'Discard' }).click();
  await pickInstrument(buyer, 'ABC');
  log('an answer for one instrument kept the unconfirmed order of another');

  let releaseOrder;
  const orderHeld = new Promise((resolve) => (releaseOrder = resolve));
  await buyer.route('**/api/orders', async (route) => {
    if (ordersApi(route.request())) await orderHeld;
    await route.continue();
  });
  await buyer.getByLabel('Price (USD)').fill('1.00');
  await buyer.getByLabel(/Quantity/).fill('1');
  await buyer.getByRole('button', { name: /^Buy ABC$/ }).click();
  await buyer.getByLabel(/Quantity/).fill('7');
  releaseOrder();
  await buyer.getByText(/Buy 1 ABC @ 1.00 accepted/).first().waitFor();
  await buyer.unroute('**/api/orders');
  await buyer.waitForTimeout(300);
  if ((await buyer.getByLabel(/Quantity/).inputValue()) !== '7') {
    throw new Error('the answer to an order wiped the quantity typed for the next one');
  }
  await buyer.getByLabel(/Quantity/).fill('');
  log('the quantity typed for the next order survived the answer to the previous one');
  await shot(seller, 'orders');

  const market = await (await browser.newContext()).newPage();
  await market.goto(`${BASE}/orderbook?instrument=ABC`);
  await waitStatus(market, 'live');
  await market.getByTestId('asks').getByText('20.00').waitFor();
  await market.getByTestId('trade').first().waitFor();
  await shot(market, 'orderbook');

  const seq = Number((await market.getByText(/^Sequence \d+/).textContent()).match(/\d+/)[0]);
  compose('exec', '-T', 'redis', 'redis-cli', 'PUBLISH', 'market:ABC',
    JSON.stringify({ type: 'book_heartbeat', heartbeat: { instrument: 'ABC', seq: seq + 5 } }));
  await market.getByText(/resynced 1×/).waitFor({ timeout: 10_000 });
  await waitStatus(market, 'live');
  log('a heartbeat ahead of the book made it fetch a fresh snapshot');

  compose('stop', '-t', '0', 'matching-engine-service');
  await waitStatus(market, 'reconnecting');
  compose('start', 'matching-engine-service');
  await waitStatus(market, 'live', 30_000);

  await placeOrder(buyer, 'buy', '20.00', '2');
  await market.getByTestId('asks').getByText('No asks').waitFor({ timeout: 10_000 });
  log('after reconnecting the book still follows every change');

  await buyer.goto(`${BASE}/wallet`);
  await buyer.getByTestId('balance-row').filter({ hasText: 'ABC' }).getByText('1003').waitFor({ timeout: 10_000 });
  log('the buyer wallet shows the 3 ABC bought');
  await shot(buyer, 'wallet');

  const walletCalls = [];
  await buyer.route('**/api/wallet', (route) => walletCalls.push(route));
  await buyer.getByRole('button', { name: 'Refresh' }).click();
  await buyer.getByRole('button', { name: 'Refresh' }).click();
  for (const deadline = Date.now() + 5_000; walletCalls.length < 2; ) {
    if (Date.now() > deadline) throw new Error('the wallet did not reload twice');
    await buyer.waitForTimeout(50);
  }
  await walletCalls[0].continue();
  await buyer.waitForTimeout(300);
  await walletCalls[1].abort();
  await buyer.getByText(/Showing the balances that loaded last/).waitFor();
  if (!(await buyer.getByTestId('balance-row').first().isVisible())) {
    throw new Error('a failed wallet reload replaced the balances that had loaded');
  }
  await buyer.unroute('**/api/wallet');
  log('a failed wallet reload keeps the balances that loaded');

  const resyncs = async () =>
    Number(((await market.getByText(/^Sequence \d+/).textContent()).match(/resynced (\d+)×/) ?? [0, 0])[1]);
  const resyncsBefore = await resyncs();
  const reloads = [
    seller.waitForRequest((request) => new URL(request.url()).pathname === '/api/orders' && request.method() === 'GET'),
    buyer.waitForRequest((request) => new URL(request.url()).pathname === '/api/wallet'),
    market.waitForRequest((request) => new URL(request.url()).pathname === '/api/market/trades'),
  ];
  compose('exec', '-T', 'redis', 'redis-cli', 'CLIENT', 'KILL', 'TYPE', 'pubsub');
  await Promise.all(reloads);
  for (const deadline = Date.now() + 10_000; (await resyncs()) <= resyncsBefore; ) {
    if (Date.now() > deadline) throw new Error('the book did not resync after the subscription was lost');
    await market.waitForTimeout(200);
  }
  await waitStatus(market, 'live');
  log('after the engines lost their Redis subscription, the orders, wallet, trades and book reloaded');

  const leaving = await (await browser.newContext()).newPage();
  await register(leaving, `browser-leaving-${run}@example.com`);
  await placeOrder(leaving, 'buy', '1.00', '1');
  await leaving.getByRole('button', { name: /browser-leaving/ }).click();
  await leaving.getByRole('menuitem', { name: 'Sign out' }).click();
  await leaving.waitForURL('**/login');
  await leaving.waitForTimeout(500);
  if (await leaving.getByText(/accepted/).count()) {
    throw new Error('an order toast stayed on screen after its user signed out');
  }
  await register(leaving, `browser-staying-${run}@example.com`);
  let answerOrder;
  const unanswered = new Promise((resolve) => (answerOrder = resolve));
  await leaving.route('**/api/orders', async (route) => {
    if (!ordersApi(route.request())) return route.continue();
    await unanswered;
    return route.fulfill({ status: 202, json: { orderId: crypto.randomUUID(), status: 'accepted' } });
  });
  await leaving.getByLabel('Price (USD)').fill('1.00');
  await leaving.getByLabel(/Quantity/).fill('1');
  await leaving.getByRole('button', { name: /^Buy ABC$/ }).click();
  await leaving.getByRole('button', { name: /browser-staying/ }).click();
  await leaving.getByRole('menuitem', { name: 'Sign out' }).click();
  await leaving.waitForURL('**/login');
  await registerHere(leaving, `browser-next-${run}@example.com`);
  answerOrder();
  await leaving.waitForTimeout(1_000);
  if (await leaving.getByText(/accepted/).count()) {
    throw new Error('the next user of the browser was told about the order of the previous one');
  }
  log("the next user of the browser does not see the answer to the previous user's order");

  await buyer.goto(`${BASE}/ops`);
  await buyer.getByText('Admins only').waitFor();
  log('the operations panel is closed to a regular user');
} catch (error) {
  console.error(`BROWSER SMOKE FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
