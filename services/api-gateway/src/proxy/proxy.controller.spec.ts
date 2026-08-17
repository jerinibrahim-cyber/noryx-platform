import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ProxyController } from "./proxy.controller";
import { ModuleRegistryService } from "../module-registry/module-registry.service";
import { ProxyService } from "./proxy.service";
import type { ModuleManifest } from "@noryx/shared-types";

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(
  overrides: Partial<{
    path: string;
    originalUrl: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = {},
) {
  return {
    path: "/v1/finance/invoices",
    originalUrl: "/v1/finance/invoices",
    method: "GET",
    headers: {},
    body: undefined,
    ...overrides,
  } as any;
}

const financeModule: ModuleManifest = {
  key: "sphere-finance",
  displayName: "Finance",
  product: "sphere",
  version: "0.1.0",
  basePath: "/v1/finance",
  serviceUrl: "http://sphere-finance:3010",
  healthCheckPath: "/health/ready",
};

describe("ProxyController", () => {
  let registry: jest.Mocked<
    Pick<ModuleRegistryService, "getAll" | "resolveByPath">
  >;
  let proxy: jest.Mocked<Pick<ProxyService, "forward">>;
  let jwt: JwtService;
  let controller: ProxyController;

  beforeEach(() => {
    registry = {
      getAll: jest.fn().mockReturnValue([financeModule]),
      resolveByPath: jest.fn(),
    };
    proxy = {
      forward: jest.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: { ok: true, data: [] },
      }),
    };
    jwt = new JwtService({ secret: "test-secret" });
    controller = new ProxyController(registry as any, proxy as any, jwt);
  });

  it("returns 503 when no modules have been registered yet", async () => {
    registry.getAll.mockReturnValue([]);
    await expect(controller.handle(mockReq(), mockRes())).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it("returns 404 when no module matches the request path", async () => {
    registry.resolveByPath.mockReturnValue(undefined);
    const res = mockRes();
    await controller.handle(mockReq({ path: "/v1/unknown" }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("rejects an unauthenticated request to a non-public module", async () => {
    registry.resolveByPath.mockReturnValue(financeModule);
    await expect(
      controller.handle(mockReq({ headers: {} }), mockRes()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a valid token that lacks entitlement for the module", async () => {
    registry.resolveByPath.mockReturnValue(financeModule);
    const token = jwt.sign({
      sub: "u1",
      tenantId: "t1",
      legalEntityId: null,
      tier: "TENANT_INTERNAL",
      roles: [],
      modules: ["orbis-helpdesk-wo"],
    });
    await expect(
      controller.handle(
        mockReq({ headers: { authorization: `Bearer ${token}` } }),
        mockRes(),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("forwards the request when the token is entitled to the module", async () => {
    registry.resolveByPath.mockReturnValue(financeModule);
    const token = jwt.sign({
      sub: "u1",
      tenantId: "t1",
      legalEntityId: null,
      tier: "TENANT_INTERNAL",
      roles: [],
      modules: ["sphere-finance"],
    });
    const res = mockRes();
    await controller.handle(
      mockReq({ headers: { authorization: `Bearer ${token}` } }),
      res,
    );

    expect(proxy.forward).toHaveBeenCalledWith(
      expect.objectContaining({ targetBaseUrl: "http://sphere-finance:3010" }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("always allows a PLATFORM_OPERATOR token regardless of entitlement or role requirements", async () => {
    registry.resolveByPath.mockReturnValue({
      ...financeModule,
      requiredRoles: ["finance.approver"],
    });
    const token = jwt.sign({
      sub: "op1",
      tenantId: null,
      legalEntityId: null,
      tier: "PLATFORM_OPERATOR",
      roles: [],
      modules: [],
    });
    const res = mockRes();
    await controller.handle(
      mockReq({ headers: { authorization: `Bearer ${token}` } }),
      res,
    );
    expect(proxy.forward).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("allows a request to a public module without a token", async () => {
    const publicModule = {
      ...financeModule,
      key: "platform-identity",
      public: true,
      basePath: "/v1/auth",
    };
    registry.resolveByPath.mockReturnValue(publicModule);
    const res = mockRes();
    await controller.handle(
      mockReq({
        path: "/v1/auth/login",
        originalUrl: "/v1/auth/login",
        method: "POST",
        headers: {},
      }),
      res,
    );
    expect(proxy.forward).toHaveBeenCalled();
  });
});
