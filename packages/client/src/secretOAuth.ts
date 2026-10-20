// An OAuth secret's shapes — what the cli's form, the /secrets routes and
// the server's OAuth object all speak (the server side is the backend's
// oauth/OAuthSecrets.ts). Next to secretName for the same reason: both
// halves name the same thing and must not drift.

/** A provider preset: one entry of the server's presets.json. */
export interface OAuthPreset {
  id: string;
  label: string;
  authUrl?: string;
  tokenUrl?: string;
  defaultScopes: string[];
  pkce: boolean;
  /** How the token endpoint is told who the client is: secret in the form
   *  body (most), HTTP Basic (Notion), or nothing (Microsoft public clients). */
  clientAuth: 'post' | 'basic' | 'none';
  /** Extra authorize-URL params (Google's access_type=offline, …). */
  authParams?: Record<string, string>;
  /** Scopes joined by this in the request; space unless the provider says otherwise (Linear: comma). */
  scopeSeparator?: string;
  /** The user supplies both endpoint URLs. */
  custom?: boolean;
  /** Curated scope bundles for the form's Setup row; a convenience, never stored. */
  setups?: Array<{ id: string; label: string; description?: string; scopes: string[] }>;
}

/** What the user configures — the plain, non-secret half. */
export interface OAuthConfig {
  provider: string;
  clientId: string;
  scopes: string[];
  /** custom provider only (presets bake these in) */
  authUrl?: string;
  tokenUrl?: string;
}

/** The connection's state, as listed with the secret. */
export interface OAuthState extends OAuthConfig {
  status: 'disconnected' | 'connected' | 'expired';
  /** epoch ms the access token lapses; null = the provider gave no expiry (the token is used as-is). */
  expiresAt: number | null;
  /** display only, from an OIDC id_token */
  accountEmail: string | null;
}

/** The redirect the cli listens on and the user registers with the
 *  provider. Fixed (rclone's convention): most providers require the exact
 *  registered URI, so a random port could never match. */
export const OAUTH_REDIRECT_URI = 'http://localhost:53682/callback';
