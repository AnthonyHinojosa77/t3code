import { useStableCallback } from "../../hooks/useStableCallback";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

export interface MaxAuthUser {
  id: string;
  email: string;
  displayName: string;
  plan: string;
}

interface MaxSession {
  user: MaxAuthUser;
  personalMode: boolean;
  logout: () => Promise<void>;
}

const MaxSessionContext = createContext<MaxSession | null>(null);

/** Logout for screens inside the gate. Throws when called outside it. */
export function useMaxLogout(): () => Promise<void> {
  const session = useContext(MaxSessionContext);
  if (!session) {
    throw new Error("useMaxLogout must be used inside MaxAuthGate");
  }
  return session.logout;
}

type AuthMode = "login" | "register";

const fieldClass =
  "w-full rounded border border-(--max-form-border) bg-(--max-black) px-3 py-2 text-sm text-(--max-bright) outline-none placeholder:text-(--max-muted) focus:border-(--max-green)";

/**
 * Outer door for the MAX session cookie. T3's own connection flow stays inside
 * this gate and is unchanged. A 401 from `/api/auth/me` shows the form.
 */
export function MaxAuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MaxAuthUser | null>(null);
  const [personalMode, setPersonalMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<AuthMode>("login");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const refreshUser = useStableCallback(async () => {
    const response = await fetch("/api/auth/me", { credentials: "include" });
    if (!response.ok) {
      setUser(null);
      return;
    }
    const data = (await response.json()) as { user?: MaxAuthUser; personalMode?: boolean };
    if (!data.user) {
      setUser(null);
      return;
    }
    setUser(data.user);
    setPersonalMode(data.personalMode === true);
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- Bootstrap the external cookie session before mounting authenticated T3.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(refreshUser)
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  const logout = useStableCallback(async () => {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    await response.text();
    if (!response.ok) throw new Error("Could not sign out. Try again.");
    setUser(null);
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setDisplayName("");
    setError(null);
    setMode("login");
    // T3 resolves its own sign-in once per page load, so start over without the session.
    window.location.assign("/");
  });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const body: Record<string, string> = { email, password };
    if (mode === "register" && displayName.trim()) body.displayName = displayName.trim();
    const sendCredentials = async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { user?: MaxAuthUser; error?: string };
      if (!response.ok || !data.user) {
        setError(data.error ?? `Request failed: ${response.status}`);
        return;
      }
      // Start T3 only after the credentials response has been fully consumed.
      await refreshUser();
    };
    // Promise handlers, not try/finally: React Compiler cannot lower a `finally` clause.
    await sendCredentials()
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Network error");
      })
      .finally(() => {
        setSubmitting(false);
      });
  }

  if (loading) {
    return (
      <div className="max-scope flex min-h-screen items-center justify-center bg-(--max-black) font-mono">
        <p className="text-sm tracking-widest text-(--max-muted)">INITIALIZING...</p>
      </div>
    );
  }

  if (user) {
    return (
      <MaxSessionContext.Provider value={{ user, personalMode, logout }}>
        {children}
      </MaxSessionContext.Provider>
    );
  }

  return (
    <div className="max-scope flex min-h-screen items-center justify-center bg-(--max-black) p-4 font-mono text-(--max-bright)">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-wider text-(--max-green)">MAX</h1>
          <p className="mt-1 text-xs tracking-widest text-(--max-muted)">MULTI-MODEL AI CONSOLE</p>
        </div>
        <form
          onSubmit={(event) => void onSubmit(event)}
          className="rounded border border-(--max-form-border) bg-(--max-panel) p-6"
        >
          <h2 className="mb-4 text-center text-xs font-semibold tracking-widest">
            {mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}
          </h2>
          {mode === "register" ? (
            <label className="mb-3 block text-3xs/normal tracking-widest text-(--max-muted)">
              DISPLAY NAME (OPTIONAL)
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
                className={`${fieldClass} mt-1`}
              />
            </label>
          ) : null}
          <label className="mb-3 block text-3xs/normal tracking-widest text-(--max-muted)">
            EMAIL
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
              className={`${fieldClass} mt-1`}
            />
          </label>
          <label className="mb-3 block text-3xs/normal tracking-widest text-(--max-muted)">
            PASSWORD
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className={`${fieldClass} mt-1`}
            />
          </label>
          {mode === "register" ? (
            <label className="mb-3 block text-3xs/normal tracking-widest text-(--max-muted)">
              CONFIRM PASSWORD
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                autoComplete="new-password"
                className={`${fieldClass} mt-1`}
              />
            </label>
          ) : null}
          {error ? <p className="mb-3 text-xs text-(--max-error)">{error}</p> : null}
          <button
            type="submit"
            disabled={submitting}
            className="min-h-10 w-full rounded bg-(--max-green) px-3 py-2 text-xs font-bold tracking-widest text-(--max-black) disabled:opacity-60"
          >
            {submitting ? "PLEASE WAIT" : mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}
          </button>
          <button
            type="button"
            className="mt-4 w-full text-3xs/normal tracking-widest text-(--max-muted)"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "NEED AN ACCOUNT? CREATE ONE" : "ALREADY REGISTERED? SIGN IN"}
          </button>
        </form>
      </div>
    </div>
  );
}
