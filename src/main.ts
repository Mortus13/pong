import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: true,
    credentials: true
  });
  // Настройка WebSocket
  app.useWebSocketAdapter(new IoAdapter(app));

  // Статические файлы
  app.useStaticAssets(join(__dirname, '..', 'public'), {prefix: '/'});
  app.setBaseViewsDir(join(__dirname, '..', 'public'));
  app.setViewEngine('html');

  await app.listen(process.env.PORT || 3000);
  console.log(`Server running`);
}
bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
