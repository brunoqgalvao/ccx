export interface OauthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export function parseTokens(blob: string): OauthTokens | null {
  try {
    const o = JSON.parse(blob)?.claudeAiOauth;
    if (typeof o?.accessToken !== 'string' || typeof o?.refreshToken !== 'string') return null;
    return { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : 0 };
  } catch {
    return null;
  }
}

export function patchTokens(blob: string, tokens: OauthTokens): string {
  const j = JSON.parse(blob);
  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error('credential blob is not a JSON object'); // silent drop would lose the token update
  }
  j.claudeAiOauth = { ...j.claudeAiOauth, ...tokens };
  return JSON.stringify(j);
}

export async function sha256hex(s: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256');
  h.update(s);
  return h.digest('hex');
}
