// @effect-diagnostics nodeBuiltinImport:off - Token files and the local `t3` CLI are process calls, not Effect services.
// @effect-diagnostics globalTimers:off - Renewal is a long-lived process timer, checked again every few hours.
// @effect-diagnostics globalDate:off - Expiry uses wall-clock time, overridable with an injected clock in tests.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Scopes verified against `AuthGrantScope` in packages/contracts/src/auth.ts.
 * The CLI flag is `--scope` (repeatable), from apps/server/src/cli/authScopes.ts.
 * `t3 auth session issue` has no `--scopes` flag.
 */
export const COMPANION_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "filesystem:read",
  "filesystem:write",
  "source-control:write",
  "terminal:operate",
  "settings:write",
] as const;

/** Explicit TTL so the 30-day session default cannot silently expire MAX. */
export const DEFAULT_TOKEN_TTL = "365d";

/** Re-issue while the current token still has a week left. */
export const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function sessionIssueArgs(ttl: string = DEFAULT_TOKEN_TTL): string[] {
  return [
    "auth",
    "session",
    "issue",
    ...COMPANION_SCOPES.flatMap((scope) => ["--scope", scope]),
    "--ttl",
    ttl,
    "--token-only",
    "--label",
    "max-companion",
  ];
}

export function parseTtlMs(ttl: string): number {
  const match = /^(\d+)(d|h|m|s)$/.exec(ttl.trim());
  const amountText = match?.[1];
  const unit = match?.[2];
  if (!amountText || !unit) {
    throw new Error("Invalid bearer token TTL. Use values like 365d, 12h, or 30m.");
  }
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Invalid bearer token TTL. Use values like 365d, 12h, or 30m.");
  }
  const unitMs =
    unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000;
  return amount * unitMs;
}

export function defaultTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MAX_COMPANION_TOKEN_PATH;
  if (override && override.trim().length > 0) return override;
  const configuredHome = env.T3CODE_HOME?.trim();
  const home =
    configuredHome && configuredHome.length > 0 ? configuredHome : path.join(homedir(), ".t3");
  return path.join(home, "max-companion-token.json");
}

interface StoredToken {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly ttl: string;
  readonly scopes: readonly string[];
}

export interface BearerTokenOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly bin?: string;
  readonly ttl?: string;
  readonly tokenPath?: string;
  readonly runIssue?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

function needsRenewal(record: StoredToken, now: number): boolean {
  return record.expiresAtMs - now <= RENEW_BEFORE_MS;
}

async function defaultRunIssue(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  // Drain stderr so a chatty CLI cannot fill the pipe and stall. Never log it:
  // a misbehaving issuer could echo the token there.
  child.stderr.on("data", () => {});
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`t3 auth session issue failed (exit ${code ?? "null"})`);
  }
  const token = Buffer.concat(stdout).toString("utf8").trim();
  if (token.length === 0 || /\s/u.test(token)) {
    throw new Error("t3 auth session issue returned an unusable token");
  }
  return token;
}

async function readStored(tokenPath: string): Promise<StoredToken | null> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("token" in parsed) ||
      !("expiresAtMs" in parsed) ||
      typeof parsed.token !== "string" ||
      typeof parsed.expiresAtMs !== "number" ||
      parsed.token.length === 0
    ) {
      return null;
    }
    await chmod(tokenPath, 0o600);
    return {
      token: parsed.token,
      expiresAtMs: parsed.expiresAtMs,
      ttl: "ttl" in parsed && typeof parsed.ttl === "string" ? parsed.ttl : DEFAULT_TOKEN_TTL,
      scopes: COMPANION_SCOPES,
    };
  } catch {
    return null;
  }
}

async function writeStored(tokenPath: string, record: StoredToken): Promise<void> {
  const directory = path.dirname(tokenPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${tokenPath}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, tokenPath);
  await chmod(tokenPath, 0o600);
}

export class BearerTokenSource {
  private current: StoredToken | null = null;
  private inflight: Promise<string> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly options: BearerTokenOptions;

  constructor(options: BearerTokenOptions = {}) {
    this.options = options;
  }

  startRenewalLoop(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.getToken().catch(() => {
        // A failed refresh keeps the previous unexpired token. Nothing secret is logged.
      });
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async getToken(): Promise<string> {
    const injected = this.env.MAX_COMPANION_BEARER_TOKEN;
    if (injected && injected.trim().length > 0) return injected.trim();
    if (this.inflight) return this.inflight;
    this.inflight = this.resolve().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private get ttl(): string {
    return this.options.ttl ?? this.env.MAX_COMPANION_TOKEN_TTL ?? DEFAULT_TOKEN_TTL;
  }

  private get tokenPath(): string {
    return this.options.tokenPath ?? defaultTokenPath(this.env);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async resolve(): Promise<string> {
    const now = this.now();
    if (!this.current) this.current = await readStored(this.tokenPath);
    if (this.current && !needsRenewal(this.current, now)) return this.current.token;
    try {
      return await this.issue(now);
    } catch (error) {
      if (this.current && this.current.expiresAtMs > now) return this.current.token;
      throw error;
    }
  }

  private async issue(now: number): Promise<string> {
    const bin = this.options.bin ?? this.env.T3_BIN ?? "t3";
    const args = sessionIssueArgs(this.ttl);
    const run = this.options.runIssue ?? defaultRunIssue;
    const token = await run(bin, args, this.env);
    const record: StoredToken = {
      token,
      expiresAtMs: now + parseTtlMs(this.ttl),
      ttl: this.ttl,
      scopes: COMPANION_SCOPES,
    };
    await writeStored(this.tokenPath, record);
    this.current = record;
    return token;
  }
}
