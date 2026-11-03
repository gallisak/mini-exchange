import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { OrdersService } from '../orders.service';
import { INSTRUMENTS } from '../../common/instruments';

/**
 * Трансляція оновлень order book підписаним клієнтам. Кожен клієнт
 * підписується на конкретний інструмент і отримує знімок глибини ринку
 * після кожної зміни.
 *
 * NOTE (стартовий код): повідомлення не мають номера послідовності —
 * клієнт не може самостійно виявити, що пропустив оновлення під час
 * розриву з'єднання. Це відповідає одній з категорій проблем у ТЗ.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(private readonly orders: OrdersService) {}

  handleConnection(client: Socket) {
    client.emit('connected', { message: 'ok' });
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, instrument: unknown) {
    if (typeof instrument !== 'string' || !INSTRUMENTS.includes(instrument)) return;
    client.join(instrument);
    client.emit('book', await this.orders.getDepth(instrument));
  }

  async broadcastDepth(instrument: string) {
    this.server.to(instrument).emit('book', await this.orders.getDepth(instrument));
  }
}
