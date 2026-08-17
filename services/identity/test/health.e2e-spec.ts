import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { closeDb } from "@noryx/db-core";
import { HealthController } from "../src/health/health.controller";

describe("Health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // The readiness check below opens @noryx/db-core's singleton connection
    // pool; without this, jest hangs at process exit waiting on that open
    // socket instead of finishing cleanly.
    await closeDb();
  });

  it("GET /health returns ok without needing a DB connection", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", service: "identity" });
  });

  it("GET /health/ready degrades gracefully when the DB is unreachable, rather than throwing", async () => {
    const res = await request(app.getHttpServer()).get("/health/ready");
    expect([200]).toContain(res.status); // handler always returns 200; body reports db state
    expect(res.body.service).toBe("identity");
    expect(["connected", "unreachable"]).toContain(res.body.db);
  });
});
