import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';
import { corsOrigins, requireEnv, trustedProxies } from './common/env';
import { JsonLogger } from './observability/json-logger';

async function bootstrap() {
  requireEnv('JWT_ACCESS_SECRET');
  requireEnv('JWT_REFRESH_SECRET');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger('matching-engine-service'),
  });
  app.set('trust proxy', trustedProxies());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: corsOrigins() });
  app.enableShutdownHooks();
  setupSwagger(app);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  new Logger('Bootstrap').log(`Listening on ${port}`);
}
bootstrap();
