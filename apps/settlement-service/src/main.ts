import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import { JsonLogger } from './observability/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger('settlement-service'),
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  setupSwagger(app);
  const port = process.env.PORT ?? 3002;
  await app.listen(port);
  new Logger('Bootstrap').log(`Listening on ${port}`);
}
bootstrap();
