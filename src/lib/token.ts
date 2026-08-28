/**
 * The Digen token wire format is `{token}:{userId}:{unixExpiry}`.
 *
 * Ported from the Python reference (skills/cli/cli/api_client.py) so the
 * gateway sees an identical header shape regardless of client language.
 */

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

export interface ParsedToken {
  raw: string;
  userId: number | null;
  expiresAt: number | null;
}

/** Split `{token}:{userId}:{unix}` if that is the shape; else the raw value with nulls. */
export function parseDigenToken(value: string): ParsedToken {
  const parts = value.split(":");
  if (parts.length >= 3) {
    const expiryPart = parts[parts.length - 1];
    const userPart = parts[parts.length - 2];
    if (
      expiryPart !== undefined &&
      userPart !== undefined &&
      isDigits(expiryPart) &&
      isDigits(userPart)
    ) {
      return {
        raw: parts.slice(0, -2).join(":"),
        userId: Number.parseInt(userPart, 10),
        expiresAt: Number.parseInt(expiryPart, 10),
      };
    }
  }
  return { raw: value, userId: null, expiresAt: null };
}

/** Build the `digen-token` header value: `{token}:{userId}:{unixExpiry}`. */
export function composeDigenToken(
  token: string,
  userId?: number | null,
  expiresAt?: number | null,
): string {
  const parsed = parseDigenToken(token);
  const uid = userId ?? parsed.userId ?? 0;
  const exp =
    expiresAt ?? parsed.expiresAt ?? Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;
  return `${parsed.raw}:${uid}:${exp}`;
}

function isDigits(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}
