import { defineConfig } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(here, '../server')

/**
 * Build the E2E database URI by swapping the database name on the app's URI.
 *
 * The suite therefore runs against `wad2-e2e`, never `wad2`. seedE2E also refuses to write to a
 * database whose name does not end in `-e2e`, so a mistake here fails loudly instead of
 * polluting real data.
 */
function e2eMongoUri() {
  const envText = readFileSync(path.join(serverDir, '.env'), 'utf8')
  const uri = envText.match(/^MONGODB_URI=(.*)$/m)?.[1]?.trim()

  if (!uri) throw new Error('server/.env has no MONGODB_URI, so the E2E database cannot be derived')

  const [beforeQuery, ...queryParts] = uri.split('?')
  const query = queryParts.length > 0 ? `?${queryParts.join('?')}` : ''
  const database = beforeQuery.slice(beforeQuery.lastIndexOf('/') + 1)

  if (database === '') throw new Error('server/.env MONGODB_URI has no database name')

  return `${beforeQuery.slice(0, beforeQuery.lastIndexOf('/'))}/${database}-e2e${query}`
}

const E2E_MONGODB_URI = e2eMongoUri()
// globalSetup runs in this process, so hand it the URI the webServer will also be given.
process.env.E2E_MONGODB_URI = E2E_MONGODB_URI

const PORT = 3100
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // The journeys share one seeded event, so running them in parallel would have them editing
  // each other's fixtures.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.js',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  // The built client is served by Express, so the suite exercises the real production shape and
  // never needs the Vite dev server.
  webServer: {
    command: 'npm start',
    cwd: serverDir,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      MONGODB_URI: E2E_MONGODB_URI,
      PORT: String(PORT),
    },
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
