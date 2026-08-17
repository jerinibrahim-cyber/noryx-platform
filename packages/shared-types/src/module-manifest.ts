/**
 * The plug-and-play contract every Noryx service publishes about itself.
 *
 * A new module (a new Orbis capability, a new Sphere module, a future
 * third-party-built extension) becomes routable, entitlement-checked, and
 * discoverable by shipping a `noryx.module.json` that satisfies this shape
 * — the API Gateway and Subscription & Entitlement Service both read it at
 * startup/deploy time. No gateway code change, no entitlement-service code
 * change, no core redeploy required to add a module; see
 * docs/plug-and-play-modules.md for the full registration walkthrough.
 */
export interface ModuleManifest {
  /** Unique, stable key — also the entitlement key checked against
   * Subscription.entitledModules. Convention: "<product>-<module>",
   * e.g. "sphere-finance", "orbis-helpdesk-wo". */
  key: string;
  displayName: string;
  /** "sphere" | "orbis" | "platform" — which product family owns this module. */
  product: "sphere" | "orbis" | "platform";
  /** Semver — the API Gateway route table is keyed by (key, majorVersion). */
  version: string;
  /** Base path the gateway mounts this module's routes under, e.g. "/v1/finance". */
  basePath: string;
  /** Internal service DNS name / URL the gateway proxies to. */
  serviceUrl: string;
  /** Event types this module publishes — documented for consumers, not enforced at runtime. */
  publishesEvents?: string[];
  /** Event types this module subscribes to. */
  subscribesToEvents?: string[];
  /** Roles that may access this module at all, before per-route RBAC. */
  requiredRoles?: string[];
  /** Health check path, polled by the gateway before routing traffic to a new module. */
  healthCheckPath: string;
  /** True for modules that must be reachable without a valid access token or
   * subscription entitlement — e.g. Identity's own login/refresh endpoints.
   * Defaults to false; only set true deliberately, and only on modules that
   * genuinely need to be reachable pre-authentication. */
  public?: boolean;
}
