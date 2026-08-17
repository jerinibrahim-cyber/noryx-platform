import { Injectable } from "@nestjs/common";
import type { IncomingHttpHeaders } from "node:http";

export interface ProxyRequestInput {
  targetBaseUrl: string;
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface ProxyResponseOutput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Forwards a request to the resolved module's service, using the platform
 * runtime's built-in fetch (Node 20+) rather than an extra HTTP client
 * dependency. Streams neither request nor response bodies (Phase 0 scope —
 * fine for JSON APIs; large file upload/download endpoints should bypass
 * the gateway or this gets revisited before Phase 5's document/OCR module).
 */
@Injectable()
export class ProxyService {
  async forward(input: ProxyRequestInput): Promise<ProxyResponseOutput> {
    const url = new URL(input.path, input.targetBaseUrl);
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase()))
        continue;
      forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    const hasBody = !["GET", "HEAD"].includes(input.method.toUpperCase());
    const response = await fetch(url, {
      method: input.method,
      headers: forwardHeaders,
      body: hasBody ? JSON.stringify(input.body) : undefined,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()))
        responseHeaders[key] = value;
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text();

    return { status: response.status, headers: responseHeaders, body };
  }
}
