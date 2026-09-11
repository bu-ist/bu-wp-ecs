/**
 * Standard schema for the WordPress auth-cookie keys/salts stored in
 * WORDPRESS.secret.wpSecretArn, alongside dbPassword/configExtra.
 *
 * These field names are constants that define the structure of the secret JSON.
 * They do not vary across deployments - every cluster's secret carries the same
 * eight field names.
 *
 * What DOES vary per deployment:
 * - The secret ARN (wpSecretArn, different per cluster)
 * - The field VALUES inside the secret (the actual generated keys/salts)
 */
export const AUTH_COOKIE_SECRET_FIELD_NAMES = {
  AUTH_KEY: 'auth-key',
  SECURE_AUTH_KEY: 'secure-auth-key',
  LOGGED_IN_KEY: 'logged-in-key',
  NONCE_KEY: 'nonce-key',
  AUTH_SALT: 'auth-salt',
  SECURE_AUTH_SALT: 'secure-auth-salt',
  LOGGED_IN_SALT: 'logged-in-salt',
  NONCE_SALT: 'nonce-salt',
} as const;

export type AuthCookieSecretFields = typeof AUTH_COOKIE_SECRET_FIELD_NAMES;
