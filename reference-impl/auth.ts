export interface Actor {
  id: string;
  displayName: string;
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64URL(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function normalizeDisplayName(value: string, fallback: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 64) || fallback;
}

export function mintUnsignedJWT(subject: string, displayName: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${base64UrlEncode({ alg: "none", typ: "JWT" })}.${base64UrlEncode({
    iss: "workspace-demo",
    sub: subject,
    name: displayName,
    iat: now,
  })}.`;
}

export function decodeJWTPayload(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  if (!payload) return {};
  return JSON.parse(decodeBase64URL(payload));
}

export function actorFromToken(token: string): Actor | null {
  const claims = decodeJWTPayload(token);
  const subject = String(claims.sub ?? "").trim();
  if (!subject) return null;
  const displayName = normalizeDisplayName(
    String(claims.name ?? claims.preferred_username ?? claims.email ?? subject),
    subject,
  );
  return {
    id: subject,
    displayName,
  };
}

export function bearerTokenFromRequest(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function actorFromRequest(req: Request): Actor | null {
  const token = bearerTokenFromRequest(req);
  return token ? actorFromToken(token) : null;
}

export function encodeInternalActor(actor: Actor): string {
  return Buffer.from(JSON.stringify(actor)).toString("base64url");
}

export function decodeInternalActor(encoded: string | null | undefined): Actor | null {
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<Actor>;
    const id = String(parsed.id ?? "").trim();
    if (!id) return null;
    return {
      id,
      displayName: normalizeDisplayName(String(parsed.displayName ?? id), id),
    };
  } catch {
    return null;
  }
}
