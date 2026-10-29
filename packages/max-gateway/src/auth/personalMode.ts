/**
 * Personal mode is on unless MAX_PERSONAL_MODE is exactly "false".
 * An unset variable stays locked to the owner.
 */
export function isPersonalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAX_PERSONAL_MODE !== "false";
}

/** OWNER_EMAIL, compared case-insensitively. Null when unset or blank. */
export function readOwnerEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  const email = env.OWNER_EMAIL?.trim().toLowerCase();
  return email && email.length > 0 ? email : null;
}

let ownerEmailWarningLogged = false;

/** One line, no address and no secret. Further calls do not log again. */
export function warnIfOwnerEmailMissing(env: NodeJS.ProcessEnv = process.env): void {
  if (!isPersonalMode(env) || readOwnerEmail(env) || ownerEmailWarningLogged) return;
  ownerEmailWarningLogged = true;
  process.stderr.write("OWNER_EMAIL is unset; personal mode rejects every register and login\n");
}
