import "dotenv/config"; // must be first — populates process.env before any module-level reads (e.g. AuthModule's JwtModule.register)
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

  // Baseline security headers — CSP, HSTS, X-Frame-Options, etc.
  // (Readiness Review §7.4: strict CSP, no exceptions).
  app.use(helmet());

  // Reject any payload with fields not declared on the DTO — the first line
  // of defense against mass-assignment and malformed-input attacks
  // (Readiness Review §7.4, OWASP ASVS input validation).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix("v1", { exclude: ["health", "health/ready"] });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[identity] listening on :${port}`);
}

bootstrap();
