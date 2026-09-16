import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createApp } from '../../src/app.js'
import { createTokenService } from '../../src/auth/tokens.js'
import { createConflictService } from '../../src/services/conflictService.js'
import { createLiveState } from '../../src/realtime/liveState.js'

// Serving the built client from Express.
//
// This is what makes the deployment single-origin, and it is also what lets the Playwright run
// exercise the real app without starting Vite at all — which matters because Vite's build step
// needs a child process the file sandbox blocks.
//
// The subtle part is the SPA fallback. A client-side route like /events/abc has no file behind
// it, so it must return index.html; but an unknown /api path must still return JSON, or a typo
// in a fetch would quietly receive an HTML page and fail with a parse error instead of a 404.

const SECRET = 'test-secret-do-not-use-in-production'
const INDEX_MARKER = '<title>SPA Marker</title>'

let server
let baseUrl
let staticDir
let apiOnlyBaseUrl
let apiOnlyServer

function makeApp(staticDirOption) {
  return createApp({
    tokenService: createTokenService({ secret: SECRET }),
    repositories: {
      users: { async findByEmail() { return null }, async findById() { return null }, async updatePassword() { return null } },
      memberships: { async listByUser() { return [] }, async find() { return null } },
      events: { async create() { return null }, async findById() { return null }, async listByCommunity() { return [] } },
      zones: { async create() { return null }, async listByEvent() { return [] } },
      groups: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
      assignments: { async create() { return null }, async listByEvent() { return [] } },
      announcements: { async create() { return null }, async findById() { return null }, async listByEvent() { return [] } },
      announcementAcks: { async upsert() { return null }, async listByAnnouncement() { return [] } },
    },
    conflictService: createConflictService({ onemapClient: null }),
    liveState: createLiveState(),
    staticDir: staticDirOption,
  })
}

async function listen(app) {
  const instance = http.createServer(app)
  await new Promise((resolve) => instance.listen(0, resolve))
  return { instance, url: `http://127.0.0.1:${instance.address().port}` }
}

beforeAll(async () => {
  // A stand-in build output, so the test does not depend on having run `vite build`.
  staticDir = await mkdtemp(path.join(tmpdir(), 'wad2-dist-'))
  await writeFile(path.join(staticDir, 'index.html'), `<!doctype html><html><head>${INDEX_MARKER}</head><body><div id="app"></div></body></html>`)
  await mkdir(path.join(staticDir, 'assets'), { recursive: true })
  await writeFile(path.join(staticDir, 'assets', 'app.js'), 'console.log("built asset")')

  const withStatic = await listen(makeApp(staticDir))
  server = withStatic.instance
  baseUrl = withStatic.url

  const withoutStatic = await listen(makeApp(undefined))
  apiOnlyServer = withoutStatic.instance
  apiOnlyBaseUrl = withoutStatic.url
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => apiOnlyServer.close(resolve))
  await rm(staticDir, { recursive: true, force: true })
})

describe('serving the built client', () => {
  it('serves the app shell at the root', async () => {
    const response = await fetch(`${baseUrl}/`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/html/)
    expect(await response.text()).toContain(INDEX_MARKER)
  })

  it('serves a real built asset', async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('built asset')
  })

  it('falls back to the app shell for a client-side route', async () => {
    // /events/abc has no file behind it; the Vue router handles it in the browser.
    const response = await fetch(`${baseUrl}/events/abc123`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/html/)
    expect(await response.text()).toContain(INDEX_MARKER)
  })

  it('still answers an unknown API path with JSON, not the app shell', async () => {
    // Returning HTML here would turn a fetch typo into a JSON parse error far from its cause.
    const response = await fetch(`${baseUrl}/api/does-not-exist`)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toMatch(/json/)
    expect((await response.json()).error).toBeDefined()
  })

  it('does not serve the shell for an unauthenticated API call', async () => {
    const response = await fetch(`${baseUrl}/api/events`)

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toMatch(/json/)
  })
})

describe('API-only mode', () => {
  it('returns JSON 404 at the root when no client build is configured', async () => {
    // The development and test default: no dist directory, so the API stands alone.
    const response = await fetch(`${apiOnlyBaseUrl}/`)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toMatch(/json/)
  })

  it('does not fall back to HTML for an unknown path', async () => {
    const response = await fetch(`${apiOnlyBaseUrl}/events/abc`)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toMatch(/json/)
  })
})
