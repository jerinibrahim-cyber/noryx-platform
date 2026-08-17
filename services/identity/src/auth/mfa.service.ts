import { Injectable } from "@nestjs/common";
import { authenticator } from "otplib";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * TOTP-based MFA (System Architecture v1 §7: "MFA enforced for all internal
 * and Platform Operator accounts"). The TOTP secret is envelope-encrypted
 * with AES-256-GCM before it's ever written to User.mfaSecretEncrypted —
 * a raw DB dump never reveals a usable secret.
 *
 * MFA_ENCRYPTION_KEY is a 32-byte hex string sourced from the managed
 * secrets vault in staging/production (Readiness Review §7.4 — no secret
 * ever lives in code or a committed .env file); .env.example documents the
 * variable but never a real value.
 */
@Injectable()
export class MfaService {
  private get encryptionKey(): Buffer {
    const hex = process.env.MFA_ENCRYPTION_KEY;
    if (!hex || hex.length !== 64) {
      throw new Error(
        "MFA_ENCRYPTION_KEY must be a 32-byte hex string (64 chars). " +
          "Generate one with `openssl rand -hex 32` and source it from the secrets vault in production.",
      );
    }
    return Buffer.from(hex, "hex");
  }

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  otpAuthUrl(email: string, secret: string): string {
    return authenticator.keyuri(email, "Noryx Platform", secret);
  }

  verifyToken(token: string, secret: string): boolean {
    return authenticator.check(token, secret);
  }

  encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // iv.authTag.ciphertext, all base64 — self-contained so decrypt only needs the key.
    return `${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`;
  }

  decryptSecret(encoded: string): string {
    const [ivB64, tagB64, dataB64] = encoded.split(".");
    if (!ivB64 || !tagB64 || !dataB64)
      throw new Error("Malformed encrypted MFA secret");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  }
}
