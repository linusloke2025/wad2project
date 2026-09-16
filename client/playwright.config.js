import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../server')

const PORT = 3100
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * End-to-end configuration.
 *
 * The suite is **self-contained**: Playwright starts `serveForE2E.mjs`, which brings up an
 * embedded MongoDB, seeds the fixtures, and then starts the real server through the real entry
 * point — which also serves the built client, so the tests exercise the production shape.
 *
 * That means running the tests needs no Atlas cluster, no `MONGODB_URI`, no IP allowlist and no
 * network. It is deliberate: a suite that depends on a cloud database stops working whenever the
 * network, the credentials or an allowlist changes, and this project lost three rounds of
 * verification to exactly that. The application still uses Atlas; only the tests are independent.
 *
 * `npm run build` in `client/` must have been run at least once, because the server serves the
 * built client rather than starting Vite.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // The journeys share one seeded event, so running them in parallel would have them editing
  // each other's fixtures.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  webServer: {
    command: 'node src/scripts/serveForE2E.mjs',
    cwd: serverDir,
    url: BASE_URL,
    reuseExistingServer: false,
    // Generous, because the very first run downloads an mongod binary.
    timeout: 300_000,
    env: { ...process.env, PORT: String(PORT) },
  },

  projects: [
    {
      // The functional journeys run once, at desktop size.
      name: 'functionality',
      testIgnore: /responsive\.spec\.js/,
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      // The responsive checks run at the three widths the brief names: the iPhone 6 at 375px,
      // the Bootstrap MD breakpoint, and the XL breakpoint at 1200px.
      name: 'mobile-375',
      testMatch: /responsive\.spec\.js/,
      use: { viewport: { width: 375, height: 667 } },
    },
    {
      name: 'tablet-768',
      testMatch: /responsive\.spec\.js/,
      use: { viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'xl-1200',
      testMatch: /responsive\.spec\.js/,
      use: { viewport: { width: 1200, height: 800 } },
    },
  ],
})
