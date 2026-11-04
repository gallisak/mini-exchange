import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Settlement')
    .setDescription(
      'Wallets, trade settlement, reconciliation and operations. ' +
        'Trades normally arrive from the per-instrument Redis streams; POST /trades/settle is an internal fallback.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-internal-key' }, 'internal-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
