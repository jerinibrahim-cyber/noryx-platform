import { Test } from "@nestjs/testing";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { TokenService } from "./token.service";

describe("TokenService", () => {
  let tokens: TokenService;
  let jwt: JwtService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: "test-secret" })],
      providers: [TokenService],
    }).compile();

    tokens = moduleRef.get(TokenService);
    jwt = moduleRef.get(JwtService);
  });

  it("issues an access token carrying the expected claims", () => {
    const user = {
      id: "user-1",
      tenantId: "tenant-1",
      legalEntityId: "le-1",
      tier: "TENANT_INTERNAL",
      roles: ["finance.approver"],
    };
    const token = tokens.issueAccessToken(user as any, ["sphere-finance"]);
    const decoded = jwt.decode(token) as any;

    expect(decoded.sub).toBe("user-1");
    expect(decoded.tenantId).toBe("tenant-1");
    expect(decoded.tier).toBe("TENANT_INTERNAL");
    expect(decoded.roles).toEqual(["finance.approver"]);
    expect(decoded.modules).toEqual(["sphere-finance"]);
  });

  it("generates unique, sufficiently long opaque refresh tokens", () => {
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(40);
  });

  it("hashes a refresh token and verifies it correctly, rejecting a wrong one", async () => {
    const raw = tokens.generateRefreshToken();
    const hash = await tokens.hashRefreshToken(raw);
    expect(hash).not.toEqual(raw);
    expect(await tokens.verifyRefreshToken(raw, hash)).toBe(true);
    expect(await tokens.verifyRefreshToken("wrong-token", hash)).toBe(false);
  });
});
