// @effect-diagnostics nodeBuiltinImport:off - The account file is a local SQLite database, not an Effect service.
// @effect-diagnostics globalDate:off - Session expiry is wall-clock time, same as MAX's 30-day cookie.
import * as NodeCrypto from "node:crypto";
const { createHash, randomBytes, randomUUID } = NodeCrypto;
import * as NodeFS from "node:fs";
const { mkdirSync } = NodeFS;
import * as NodePath from "node:path";
const path = NodePath;
import * as NodeSqlite from "node:sqlite";
const { DatabaseSync } = NodeSqlite;

/** Cookie lifetime. MAX uses the same 30 days. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "maximus_session";

/** Railway mounts a directory (append max.sqlite), or accepts a .sqlite file.
 * Tests pass MAX_DB_PATH or a temp path to avoid writing the deployment volume. */
export function resolveAuthDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (mount && mount.length > 0) {
    return mount.endsWith(".sqlite") ? mount : path.join(mount, "max.sqlite");
  }
  const explicit = env.MAX_DB_PATH?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return "/data/max.sqlite";
}

export interface StoredUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly plan: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeStatus: string | null;
  readonly stripePriceId: string | null;
  readonly stripeInterval: string | null;
  readonly currentPeriodEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly entitlementOverride: string | null;
  readonly creditBalanceCents: number;
}

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly plan: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  stripe_price_id: string | null;
  stripe_interval: string | null;
  current_period_end: number | null;
  cancel_at_period_end: number | null;
  entitlement_override: string | null;
  credit_balance_cents: number | null;
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    plan: row.plan,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeStatus: row.stripe_status,
    stripePriceId: row.stripe_price_id,
    stripeInterval: row.stripe_interval,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    entitlementOverride: row.entitlement_override,
    creditBalanceCents: row.credit_balance_cents ?? 0,
  };
}

export function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    plan: user.plan,
  };
}

export interface AuthStore {
  insertUser(input: {
    email: string;
    passwordHash: string;
    displayName: string;
    plan?: string;
  }): StoredUser;
  getUserByEmail(email: string): StoredUser | null;
  getUserById(id: string): StoredUser | null;
  /** Raw cookie token. Only its SHA-256 hash is stored. */
  createSession(userId: string, now?: number): { token: string; expiresAt: number };
  readSession(token: string, now?: number): StoredUser | null;
  deleteSession(token: string): void;
  /** Test helper. Marks the session already expired. */
  expireSession(token: string): void;
  setStripeCustomerId(userId: string, customerId: string): void;
  pruneExpired(now?: number): void;
  close(): void;
}

/**
 * Users and sessions only. Invite-code tables from MAX are not created.
 * Session rows keep `token_hash`, not the cookie value. MAX stored the raw
 * session id; this store does not.
 */
export function openAuthStore(dbPath: string): AuthStore {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      plan TEXT NOT NULL DEFAULT 'beta',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_status TEXT,
      stripe_price_id TEXT,
      stripe_interval TEXT,
      current_period_end INTEGER,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      entitlement_override TEXT,
      credit_balance_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  const insert = db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, created_at, plan)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const byEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  const byId = db.prepare("SELECT * FROM users WHERE id = ?");
  const insertSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  );
  const byHash = db.prepare(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?`,
  );
  const sessionExpiry = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?");
  const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const expireStmt = db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?");
  const prune = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
  const setCustomer = db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?");

  function userByEmail(email: string): StoredUser | null {
    const row = byEmail.get(email) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  return {
    insertUser(input) {
      const email = input.email.trim().toLowerCase();
      const id = randomUUID();
      insert.run(
        id,
        email,
        input.passwordHash,
        input.displayName,
        Date.now(),
        input.plan ?? "beta",
      );
      const created = userByEmail(email);
      if (!created) throw new Error("user insert failed");
      return created;
    },
    getUserByEmail(email) {
      return userByEmail(email.trim().toLowerCase());
    },
    getUserById(id) {
      const row = byId.get(id) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },
    createSession(userId, now = Date.now()) {
      prune.run(now);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now + SESSION_MAX_AGE_MS;
      insertSession.run(sha256(token), userId, now, expiresAt);
      return { token, expiresAt };
    },
    readSession(token, now = Date.now()) {
      const hash = sha256(token);
      const expiry = sessionExpiry.get(hash) as { expires_at: number } | undefined;
      if (!expiry) return null;
      if (now > expiry.expires_at) {
        deleteSessionStmt.run(hash);
        return null;
      }
      const row = byHash.get(hash) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },
    deleteSession(token) {
      deleteSessionStmt.run(sha256(token));
    },
    expireSession(token) {
      expireStmt.run(1, sha256(token));
    },
    setStripeCustomerId(userId, customerId) {
      setCustomer.run(customerId, userId);
    },
    pruneExpired(now = Date.now()) {
      prune.run(now);
    },
    close() {
      db.close();
    },
  };
}
