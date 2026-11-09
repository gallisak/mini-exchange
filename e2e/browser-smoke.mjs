import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const ENGINE = process.env.ENGINE_URL ?? 'http://localhost:3001';
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
  await buyer.getByLabel(/Quantity/).fill('1');
  releaseOrder();
  await buyer.getByText(/Buy 1 ABC @ 1.00 accepted/).first().waitFor();
  await buyer.unroute('**/api/orders');
  await buyer.waitForTimeout(300);
  if ((await buyer.getByLabel(/Quantity/).inputValue()) !== '1') {
    throw new Error('the answer to an order wiped the quantity typed for the next one, the same number as its own');
  }
  await buyer.getByLabel(/Quantity/).fill('');
  log('the quantity typed for the next order survived the answer to the previous one, even the same number');

  let releaseSecond;
  const secondHeld = new Promise((resolve) => (releaseSecond = resolve));
  await buyer.route('**/api/orders', async (route) => {
    if (ordersApi(route.request())) await secondHeld;
    await route.continue();
  });
  await buyer.getByLabel(/Quantity/).fill('2');
  await buyer.getByRole('button', { name: /^Buy ABC$/ }).click();
  await buyer.getByLabel(/Quantity/).press('Space');
  releaseSecond();
  await buyer.getByText(/Buy 2 ABC @ 1.00 accepted/).first().waitFor();
  await buyer.unroute('**/api/orders');
  await buyer.waitForTimeout(300);
  if ((await buyer.getByLabel(/Quantity/).inputValue()) !== '') {
    throw new Error('a stray key press kept the quantity of an order that was accepted');
  }
  log('a stray key press does not keep the quantity of the order just accepted');

  await buyer.route('**/api/orders/*', (route) =>
    route.request().method() === 'DELETE' ? route.fulfill({ status: 202, json: {} }) : route.continue(),
  );
  const cancelButton = buyer.getByRole('button', { name: /^Cancel buy 2\S* ABC at 1\.00/ }).first();
  await cancelButton.click();
  await buyer.waitForTimeout(300);
  if (await cancelButton.isEnabled()) throw new Error('a cancel on its way could be sent again at once');
  await buyer.waitForTimeout(5_500);
  if (!(await cancelButton.isEnabled())) {
    throw new Error('the Cancel button stayed off for an order that was still open');
  }
  await buyer.unroute('**/api/orders/*');
  log('the Cancel button says which order it is for and comes back if the order stays open');
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
  await market.route('**/api/market/trades*', (route) => route.abort());
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
  await market.getByText(/Showing the trades that loaded last/).waitFor();
  if (!(await market.getByTestId('trade').first().isVisible())) {
    throw new Error('a failed reload of the trades hid the trades that had loaded');
  }
  await market.unroute('**/api/market/trades*');
  log('a failed reload of the trades keeps the trades that loaded');

  const leaving = await (await browser.newContext()).newPage();
  await leaving.addInitScript(() => {
    window.__toasts = [];
    new MutationObserver((changes) => {
      for (const { addedNodes } of changes) {
        for (const node of addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('[data-sonner-toast]') || node.querySelector('[data-sonner-toast]')) {
            window.__toasts.push(node.textContent);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await register(leaving, `browser-leaving-${run}@example.com`);
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
  await leaving.getByRole('button', { name: /browser-leaving/ }).click();
  await leaving.getByRole('menuitem', { name: 'Sign out' }).click();
  await leaving.waitForURL('**/login');
  await registerHere(leaving, `browser-next-${run}@example.com`);
  answerOrder();
  await leaving.waitForTimeout(1_000);
  if (await leaving.getByText(/accepted/).count()) {
    throw new Error('the next user of the browser was told about the order of the previous one');
  }
  log("the next user of the browser does not see the answer to the previous user's order");

  await leaving.unroute('**/api/orders');
  await leaving.route('**/api/orders', (route) =>
    ordersApi(route.request()) ? route.fulfill({ status: 401, json: { message: 'Sign in to continue' } }) : route.continue(),
  );
  await leaving.getByLabel('Price (USD)').fill('1.00');
  await leaving.getByLabel(/Quantity/).fill('1');
  await leaving.evaluate(() => {
    window.__toasts = [];
  });
  await leaving.getByRole('button', { name: /^Buy ABC$/ }).click();
  await leaving.getByRole('link', { name: 'Sign in' }).last().waitFor();
  await leaving.waitForTimeout(300);
  const flashed = await leaving.evaluate(() => window.__toasts);
  if (flashed.length > 0) {
    throw new Error(`a session that ended flashed a toast on its way out: ${flashed.join(', ')}`);
  }
  log('a session that ended goes straight to the sign-in card, with no toast that disappears');

  const shared = await browser.newContext();
  const first = await shared.newPage();
  await register(first, `browser-tab-a-${run}@example.com`);
  const second = await shared.newPage();
  await second.goto(`${BASE}/login`);
  await second.waitForURL('**/orders');
  log('the sign-in page sends someone already signed in onward');
  await first.getByLabel('Price (USD)').fill('1.00');
  await placeOrder(second, 'buy', '1.00', '1');
  await second.getByRole('button', { name: /browser-tab-a/ }).click();
  await second.getByRole('menuitem', { name: 'Sign out' }).click();
  await second.waitForURL('**/login');
  await second.waitForTimeout(500);
  if (await second.getByText(/accepted/).count()) {
    throw new Error('an order toast stayed on screen after its user signed out');
  }
  await registerHere(second, `browser-tab-b-${run}@example.com`);
  await first.getByRole('button', { name: /browser-tab-b/ }).waitFor({ timeout: 5_000 });
  if ((await first.getByLabel('Price (USD)').inputValue()) !== '') {
    throw new Error('a tab that switched accounts kept what was typed for the previous one');
  }
  log('a tab follows a sign-in in another tab, and forgets what was typed for the previous account');

  let refusedTickets = 0;
  first.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/ws-token' && response.status() === 409) refusedTickets += 1;
  });
  await first.getByLabel('Price (USD)').fill('3.00');
  const replaced = (await shared.cookies()).find(({ name }) => name.includes('mx_refresh_'));
  const switched = await second.evaluate(
    (email) =>
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' }),
      }).then(async (response) => {
        const answer = await response.json().catch(() => ({}));
        if (response.ok) new BroadcastChannel('mx:session').postMessage(answer.session);
        return response.status;
      }),
    `browser-tab-a-${run}@example.com`,
  );
  if (switched !== 200) throw new Error(`the other account could not sign in: ${switched}`);
  if ((await shared.cookies()).some(({ name }) => name === replaced.name)) {
    throw new Error('a sign-in kept the cookies of a session the engine ended');
  }
  const stillAlive = await fetch(`${ENGINE}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: replaced.value.split('~')[0] }),
  });
  if (stillAlive.status !== 401) throw new Error(`a forgotten session still works: ${stillAlive.status}`);
  log('a sign-in ends on the engine the session it replaces, and only then forgets its cookies');
  await first.bringToFront();
  await first.evaluate(() => window.dispatchEvent(new Event('focus')));
  await first.getByRole('button', { name: /browser-tab-a/ }).waitFor({ timeout: 5_000 });
  if ((await first.getByLabel('Price (USD)').inputValue()) !== '') {
    throw new Error('a tab that went straight to another account kept what was typed for the previous one');
  }
  await first.waitForTimeout(2_000);
  if (refusedTickets > 1) throw new Error(`the socket kept asking for a ticket: ${refusedTickets} answers of 409`);
  log('a tab goes straight from one account to another, forgets the form, and its socket does not loop on 409');

  const unaware = await browser.newContext();
  await unaware.addInitScript(() => delete window.BroadcastChannel);
  const staleTab = await unaware.newPage();
  await register(staleTab, `browser-stale-a-${run}@example.com`);
  const staleEmail = `browser-stale-b-${run}@example.com`;
  await staleTab.route('**/api/auth/session', (route) => route.abort());
  const signedIn = await unaware.request.post(`${BASE}/api/auth/register`, {
    data: { email: staleEmail, password: 'password123' },
  });
  if (!signedIn.ok()) throw new Error(`the second account could not sign in: ${signedIn.status()}`);
  const stalePost = staleTab.waitForResponse((response) => ordersApi(response.request()));
  await staleTab.getByLabel('Price (USD)').fill('1.00');
  await staleTab.getByLabel(/Quantity/).fill('1');
  await staleTab.getByRole('button', { name: /^Buy ABC$/ }).click();
  if ((await stalePost).status() !== 409) {
    throw new Error('a tab that still showed the previous account placed an order on the new one');
  }
  await staleTab.waitForTimeout(300);
  await staleTab.unroute('**/api/auth/session');
  await staleTab.evaluate(() => window.dispatchEvent(new Event('focus')));
  await staleTab.getByRole('link', { name: 'Sign in' }).last().waitFor({ timeout: 10_000 });
  if (await staleTab.getByRole('button', { name: /browser-stale-b/ }).count()) {
    throw new Error('a tab whose sign-in was replaced without its knowing took over the other sign-in of the browser');
  }
  log('a tab that did not hear of the new sign-in cannot trade on it, and asks to sign in instead of taking it');

  await buyer.goto(`${BASE}/ops`);
  await buyer.getByText('Admins only').waitFor();
  log('the operations panel is closed to a regular user');

  const admin = await (await browser.newContext()).newPage();
  compose('exec', '-T', 'matching-engine-1', 'sh', '/opt/secrets/with-secrets.sh', 'node', 'dist/tools/grant-admin.js', staleEmail);
  await admin.goto(`${BASE}/login`);
  await admin.getByLabel('Email').fill(staleEmail);
  await admin.getByLabel('Password').fill('password123');
  await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
  await admin.waitForURL('**/orders');
  await admin.goto(`${BASE}/ops`);
  await admin.getByTestId('reconciliation-status').waitFor({ timeout: 60_000 });
  await admin.route('**/api/ops/reconciliation', (route) => route.abort());
  await admin.getByRole('button', { name: 'Refresh' }).click();
  await admin.getByTestId('reconciliation-stale').waitFor();
  if (!(await admin.getByTestId('reconciliation-status').isVisible())) {
    throw new Error('a failed reconciliation refresh hid the last result');
  }
  log('a failed reconciliation refresh keeps the last result on the operations panel');
} catch (error) {
  console.error(`BROWSER SMOKE FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
