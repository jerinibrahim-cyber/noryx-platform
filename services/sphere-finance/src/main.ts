import "dotenv/config"; // must be first — populates process.env before any module-level reads (e.g. AppModule's JwtModule.register)
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix("v1/finance", {
    exclude: ["health", "health/ready"],
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3010;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[sphere-finance] listening on :${port}`);
}

bootstrap();
