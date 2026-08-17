import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { HealthController } from "../src/health/health.controller";
import { ModuleRegistryService } from "../src/module-registry/module-registry.service";

describe("Gateway health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NORYX_MODULES_MANIFEST_DIR = "/nonexistent-for-this-test";
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [ModuleRegistryService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", service: "api-gateway" });
  });

  it("GET /health/ready reports degraded when no modules are registered", async () => {
    const res = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.registeredModules).toEqual([]);
  });

  it("GET /health/modules returns an empty list before any manifests load", async () => {
    const res = await request(app.getHttpServer())
      .get("/health/modules")
      .expect(200);
    expect(res.body).toEqual([]);
  });
});
