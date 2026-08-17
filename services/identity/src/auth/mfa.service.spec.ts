import { MfaService } from "./mfa.service";
import { authenticator } from "otplib";

describe("MfaService", () => {
  let mfa: MfaService;

  beforeEach(() => {
    mfa = new MfaService();
  });

  it("generates a secret and a matching otpauth URL", () => {
    const secret = mfa.generateSecret();
    expect(secret).toBeTruthy();
    const url = mfa.otpAuthUrl("user@example.com", secret);
    expect(url).toContain("otpauth://totp/");
    expect(url).toContain("Noryx%20Platform");
  });

  it("verifies a valid TOTP token and rejects an invalid one", () => {
    const secret = mfa.generateSecret();
    const validToken = authenticator.generate(secret);
    expect(mfa.verifyToken(validToken, secret)).toBe(true);
    expect(mfa.verifyToken("000000", secret)).toBe(false);
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const secret = mfa.generateSecret();
    const encrypted = mfa.encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(mfa.decryptSecret(encrypted)).toBe(secret);
  });

  it("produces different ciphertext for the same secret on repeated calls (random IV)", () => {
    const secret = mfa.generateSecret();
    const a = mfa.encryptSecret(secret);
    const b = mfa.encryptSecret(secret);
    expect(a).not.toEqual(b);
    expect(mfa.decryptSecret(a)).toBe(secret);
    expect(mfa.decryptSecret(b)).toBe(secret);
  });

  it("throws on a malformed encrypted payload instead of silently returning garbage", () => {
    expect(() => mfa.decryptSecret("not-a-valid-payload")).toThrow();
  });
});
