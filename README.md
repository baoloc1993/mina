# Mina — offline-first mini-app platform

Mina is a "super app" platform: an Android shell (Expo / React Native) that installs, runs and syncs small sandboxed
web mini apps inside WebViews. Mini apps are signed zip packages published through a registry CLI; each one gets its
own tenant-scoped tables that live in SQLite on the device and sync to Postgres via PowerSync, and it talks to the host
only through a permission-checked JSON-RPC bridge (the mini-app SDK). The repo contains the backend (Supabase), the
mobile shell, the SDK with a browser mock, and three mini apps built on it: Notes, Calendar and a News/RSS reader.

The UI text and most code comments are in Vietnamese.

## Features

- **Multi-tenant backend** — Supabase Postgres with row-level security on every synced table; tenant id comes from the JWT.
- **Email OTP sign-in** (Google / Apple OAuth wired but optional), device registration and remote session revocation.
- **Mini-app registry** — CLI to publish, test (draft + tester tenants), promote and revoke versions; packages are
  reproducible zips signed with Ed25519 and verified on the device (SHA-256 + signature + SDK semver range), with rollback
  to the previous installed version.
- **Additive-only migrations** per mini app, linted by the CLI and applied both to Postgres and to on-device SQLite.
- **Offline-first sync** — PowerSync with a dynamic schema per installed app, batched uploads (≤ 100 ops) with
  last-write-wins, a rejection queue, and per-user rate limits on Edge Functions.
- **Sandboxed bridge** — scope-based permissions (`db.own`, `core.tags`, `intent.send`, `net`, `notify.local`, …),
  SQL guard restricting queries to the app's own tables, network whitelist plus per-host user grants, CSP injection,
  at most 3 live WebViews.
- **Inter-app intents** with JSON-Schema-validated payloads (e.g. Notes → Calendar reminder).
- **Entitlements** — plan / app quota, read-only mode after a grace period, measured with a monotonic clock.
- **Shared core data** (tags, contacts, files) and large files via Supabase Storage with an on-device LRU cache.
- **Browser mock of the SDK** (Vite + SQLite WASM) so mini apps can be developed without a phone.
- **Mini apps**: Notes (TipTap + Yjs, accent-insensitive search, tags, attachments, trash), Calendar (recurrence,
  lunar dates, local notifications), News reader (RSS/Atom parsing, user-approved hosts, read/saved state).
- **Ops tooling** — production deploy script with preflight checks, smoke test, structured logs, health endpoint,
  backup / restore verification, signed release APK builds.

## Tech stack

| Area | Technology |
|---|---|
| Backend | Supabase (PostgreSQL, RLS, Auth, Storage, Edge Functions on Deno), pg_cron, pgTAP |
| Sync | PowerSync (Open Edition + MongoDB locally, PowerSync Cloud in production) |
| Registry / ops CLI | Node.js + TypeScript (`pg`, `jose`, `fflate`, `@supabase/supabase-js`) |
| Mobile shell | Expo / React Native, TypeScript, op-sqlite (SQLCipher), react-native-webview, Jest |
| Mini-app SDK | TypeScript, design tokens, Vite + SQLite WASM mock, Vitest |
| Mini apps | React + Vite, TipTap / Yjs (Notes), Vitest |
| Tooling | Make, Docker Compose, Python 3 (seed and deploy scripts) |

## Architecture

```
 ┌──────────────────── Android shell (mobile/) ────────────────────┐
 │  UI screens ── Runtime ── Package manager (verify, unzip, migrate) │
 │                   │                                               │
 │  WebView (mini app) ⇄ JSON-RPC bridge (scope / SQL / net guards)  │
 │                   │                                               │
 │          SQLite (SQLCipher) ⇄ PowerSync client                    │
 └──────────────┬──────────────────────────────┬────────────────────┘
                │ sync (JWT)                   │ HTTPS
         PowerSync service          Supabase Edge Functions
                │                   (catalog, upload, issue-app-token, health)
                └────── Postgres (RLS, per-app tables) ──────┘
                                   ▲
                       registry CLI (backend/scripts)
```

- The shell fetches the catalog, installs signed packages and creates the app's tables locally from its migrations.
- Mini apps call `window.miniapp.*` (injected SDK); every call goes through the bridge, which checks the manifest scopes.
- Writes are queued locally and uploaded in batches through the `upload` Edge Function; PowerSync streams changes back.

## Run locally

Prerequisites: Docker, Node.js 23.6+ (the CLI runs `.ts` files with native type stripping), Python 3, GNU Make,
an Android SDK / emulator for the shell, and Deno for the Edge Function tests.

```bash
cp deployment/.env.example deployment/local/.env   # fill in local values (see comments in the file)
make dev        # Supabase + PowerSync (docker), local signing key, Metro for the Android dev build
make seed       # sample tenants (a@test.local, b@test.local) and published sample apps
```

The first time, build the dev client: `cd mobile && npx expo run:android`.
Sign in with any email; the OTP code appears in the local Mailpit at http://127.0.0.1:54324.

Develop a mini app in the browser without a device:

```bash
make mock FIXTURE=fixtures/miniapp-hello
```

## Tests

```bash
make check     # design tokens, typecheck shell / SDK / mini apps / CLI / Edge Functions, build mini apps
make test      # pgTAP, Deno, Node CLI tests, Jest (shell), Vitest (SDK, mock, mini apps), Python deploy tests
make accept    # HTTP acceptance tests against a running local backend (after make dev + make seed)
```

Single suites, e.g. `cd backend && npm ci && npm run test:cli`, or `python -m unittest deployment/prod/test_deploy.py`.

## Project structure

```
backend/                Supabase project + registry / ops CLI
  supabase/migrations/  versioned SQL migrations (RLS, registry, sync, rate limits)
  supabase/functions/   Edge Functions: catalog, upload, issue-app-token, health
  supabase/tests/       pgTAP tests
  powersync/            PowerSync config and sync rules
  scripts/              registry CLI, acceptance / smoke tests, ops scripts
mobile/                 Expo / React Native shell
  src/                  bridge, package manager, store (SQLite + PowerSync), runtime, native services, UI
  packages/miniapp-sdk/ mini-app SDK, design tokens, browser mock, SDK tests
  fixtures/             test mini apps used by tests and the seed script
  scripts/              release APK build, keystore helper
miniapps/               mini apps built on the SDK
  miniapp-note/         Notes
  miniapp-calendar/     Calendar
  miniapp-news/         News / RSS reader
deployment/
  .env.example          all environment variable names (no values)
  local/                docker-compose (PowerSync + MongoDB), seed script, fake RSS server
  prod/                 production deploy script and its tests
prototype/              static HTML prototypes of the shell and mini-app screens
Makefile                dev / check / test / seed / mock / accept / migrate / deploy / release targets
```

More detail per component (in Vietnamese): [backend/README.md](backend/README.md), [mobile/README.md](mobile/README.md),
[mobile/packages/miniapp-sdk/README.md](mobile/packages/miniapp-sdk/README.md),
[deployment/prod/README.md](deployment/prod/README.md).
