/**
 * The Digen token wire format is `{token}:{userId}:{unixExpiry}`.
 *
 * The gateway now also issues an extended form,
 * `{token}:{userId}:{unixExpiry}:{suffix}`. The suffix is part of the
 * credential and must be forwarded unchanged. Re-wrapping that value (the
 * old composer does this whenever the last segment is not all digits)
 * makes every authenticated call fail with `token invalid`.
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

/**
 * Extended credentials look like `{token}:{userId}:{unixExpiry}:{suffix}`.
 * `userId` is digits and `unixExpiry` is a 10-digit unix timestamp; the
 * suffix is required by the gateway and is not itself all digits.
 */
export function isExtendedWireToken(value: string): boolean {
  const match = /:(\d+):(\d{10}):.+/.exec(value);
  if (!match?.[2]) return false;
  const exp = Number(match[2]);
  return exp >= 1_000_000_000 && exp < 10_000_000_000;
}

/** Build the `digen-token` header value: `{token}:{userId}:{unixExpiry}`. */
export function composeDigenToken(
  token: string,
  userId?: number | null,
  expiresAt?: number | null,
): string {
  if (isExtendedWireToken(token)) return token;
  const parsed = parseDigenToken(token);
  const uid = userId ?? parsed.userId ?? 0;
  const exp =
    expiresAt ?? parsed.expiresAt ?? Math.floor(Date.now() / 1000) + DEFAULT_TOKEN_TTL_SECONDS;
  return `${parsed.raw}:${uid}:${exp}`;
}

function isDigits(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}
