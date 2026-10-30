# MAX phone walkthrough and deployed smoke

Run `corepack pnpm e2e:max` for every PR touching MAX, web, or the gateway. It builds the production web app, starts an isolated loopback gateway and companion, and drives the real T3 engine at `127.0.0.1:3773` with headless Chromium at 390×844, scale 3, touch/mobile enabled. Run `corepack pnpm e2e:max -- --skip-build` only when this checkout's web build is already current.

Prerequisites: `corepack pnpm install --frozen-lockfile`, Node matching the root manifest, a running T3 engine, `~/.t3/bin/t3`, and `PLAYWRIGHT_BROWSERS_PATH` pointing to already installed Playwright Chromium. The command does not download browsers. The CLI must support `auth session issue --json` and `auth session revoke`. Normal production builds also require the repository's generated license notices; if using the manager's existing `.generated/` cache, copy it into this checkout rather than linking or writing to the source.

The local test registers only `owner@example.com`, signs out and back in, waits for council bootstrap, chooses two contenders and a synthesizer, checks provider usage against engine snapshots, opens the Agent new-thread view without sending, returns to Council, reloads the session, and signs out. No prompts are sent and no threads are created. A real engine with an existing project and two selectable models is required. Unsupported provider usage is recorded as skipped only when the engine snapshot reports no windows.

Each run uses temporary auth/council databases, template directory, a random tunnel secret and a separate companion token file. It issues one one-hour session and supplies that token to its companion to avoid the companion's normal seven-day renewal window renewing a short-lived test token. The exact session is revoked at teardown. The live token file, live companion service and engine process are never changed. SIGINT/SIGTERM stop the processes this command owns and revoke its session; SIGKILL cannot run cleanup.

Artifacts go to `artifacts/e2e-max/<UTC timestamp>/`: numbered step screenshots, `summary.json`, `console.json`, and `network-failures.json`. They are ignored by Git and may contain private UI content from existing threads: share only after inspecting/redacting. Request query strings and test credentials are redacted in diagnostic logs; cookies and authorization headers are never recorded. A failed step saves a screenshot and returns nonzero. Layout/console/network gates accumulate so the report can show multiple defects in one walkthrough.

Every visited screen is checked for horizontal overflow, truncated MAX wordmarks, and primary buttons smaller than 32 CSS pixels in either dimension. Primary buttons include auth submission, mode switching, model pickers and the Council return. Uncaught page errors, console errors and failed same-origin requests fail the run; the sole allowlisted response is the anonymous `/api/auth/me` 401 used to display the login form (including Chromium's matching resource-error console line). Long tasks over 200 ms are recorded across navigations; more than ten fails the run. This initial budget allows cold production bootstrap across registration, login and reload, but rejects repeated stalls; it is a reproducible regression signal, not proof of real-phone frame rate.

Run after every merge/redeploy:

```sh
corepack pnpm smoke:max -- --url https://max-gateway-production.up.railway.app
corepack pnpm smoke:max -- --url https://max-gateway-production.up.railway.app --expect-commit <full-git-sha>
```

Smoke is anonymous and read-only: health, unauthenticated session/descriptor, denied council/environment/WebSocket access, index-referenced JavaScript/CSS, and manifest/icons. It never registers or signs in. `--expect-commit` additionally matches `/__max/version` to Railway's `RAILWAY_GIT_COMMIT_SHA`; a pre-deployment gateway cannot pass that check. Every row prints PASS/FAIL and any failure exits nonzero. Neither command deploys, restarts the engine, or repairs defects it finds.

The scripts live in `e2e/max/` to keep complete-stack tests separate from component/browser tests. They resolve the web package's existing Playwright and gateway's existing WebSocket dependency. Extend the walkthrough with real council-round assertions after the council slices integrate; do not add fake requests or placeholder passing steps.
