import { Socket, io } from 'socket.io-client';
import { EngineProcess, api, startEngine, stopEngine, waitForOwner } from './engines';
import { eventually, range, resetState } from './harness';

interface Level {
  price: string;
  quantity: string;
  orders: number;
}

interface Snapshot {
  instrument: string;
  seq: number;
  bids: Level[];
  asks: Level[];
}

interface Delta {
  seq: number;
  changes: (Level & { side: 'buy' | 'sell' })[];
}

class BookMirror {
  seq = -1;
  gaps = 0;
  private readonly sides = { buy: new Map<string, Level>(), sell: new Map<string, Level>() };
  private readonly early: Delta[] = [];

  constructor(readonly socket: Socket) {
    socket.on('book_snapshot', (snapshot: Snapshot) => {
      this.sides.buy = new Map(snapshot.bids.map((level) => [level.price, level]));
      this.sides.sell = new Map(snapshot.asks.map((level) => [level.price, level]));
      this.seq = snapshot.seq;
      this.early.splice(0).forEach((delta) => this.apply(delta));
    });
    socket.on('book_delta', (delta: Delta) =>
      this.seq < 0 ? this.early.push(delta) : this.apply(delta),
    );
    socket.emit('subscribe', 'ABC');
  }

  private apply(delta: Delta): void {
    if (delta.seq <= this.seq) return;
    if (delta.seq !== this.seq + 1) this.gaps += 1;
    for (const { side, ...level } of delta.changes) {
      if (level.orders === 0) this.sides[side].delete(level.price);
      else this.sides[side].set(level.price, level);
    }
    this.seq = delta.seq;
  }

  view() {
    const sorted = (side: 'buy' | 'sell') =>
      [...this.sides[side].values()].sort((a, b) =>
        side === 'buy' ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price),
      );
    return { seq: this.seq, bids: sorted('buy'), asks: sorted('sell') };
  }
}

describe('order book across engine instances', () => {
  const engines: EngineProcess[] = [];
  const sockets: Socket[] = [];

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await Promise.all(engines.splice(0).map((engine) => stopEngine(engine, 'SIGKILL')));
  });

  it('shows the same live book to clients connected to different instances', async () => {
    const owner = await startEngine('engine-a', 4201);
    engines.push(owner);
    await waitForOwner('ABC', 'engine-a');
    const standby = await startEngine('engine-b', 4202);
    engines.push(standby);
    const mirrors = [owner, standby].map((engine) => {
      const socket = io(engine.url, { transports: ['websocket'] });
      sockets.push(socket);
      return new BookMirror(socket);
    });
    await eventually(async () => expect(mirrors.every((mirror) => mirror.seq >= 0)).toBe(true));

    const viaOwner = api(owner);
    const viaStandby = api(standby);
    const [seller, buyer] = [await viaOwner.register(), await viaStandby.register()];
    await Promise.all(
      range(20).map((i) =>
        i % 2 === 0
          ? viaOwner.submit(seller, { side: 'sell', price: `${100 + (i % 5)}.00`, quantity: '1.5' })
          : viaStandby.submit(buyer, { side: 'buy', price: `${99 + (i % 4)}.00`, quantity: '1' }),
      ),
    );

    await eventually(async () => {
      const response = await fetch(`${standby.url}/orders/book?instrument=ABC`);
      const { seq, bids, asks } = (await response.json()) as Snapshot;
      expect(seq).toBeGreaterThan(0);
      for (const mirror of mirrors) expect(mirror.view()).toEqual({ seq, bids, asks });
    }, 10000);
    expect(mirrors.map((mirror) => mirror.gaps)).toEqual([0, 0]);
  });
});
