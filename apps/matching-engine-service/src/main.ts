import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, uniquelocal');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`matching-engine-service (${process.env.INSTANCE_ID ?? 'engine'}) listening on ${port}`);
}
bootstrap();
