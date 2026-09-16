import { defineStore } from 'pinia'

import { createApiClient } from '@/api/client.js'

const STORAGE_KEY = 'wad2.session'

/**
 * The session: token plus the active membership.
 *
 * The token names the community the user is acting in, because roles are per-community. So
 * "switching community" is really "logging in again against a different community" — which is
 * why `communities` is remembered here: after a login that had to ask which community, the
 * picker can offer the same list next time without a round trip.
 *
 * The token is kept in localStorage so the Socket.IO handshake can present it. That is a real
 * tradeoff worth stating plainly: an httpOnly cookie would be safer against XSS, but a socket
 * handshake cannot read an httpOnly cookie from JavaScript. For a coursework prototype with
 * no third-party scripts, localStorage is the pragmatic choice; a production build would move
 * to a cookie plus a short-lived socket ticket.
 */
export const useAuthStore = defineStore('auth', {
  state() {
    const saved = safeParse(localStorage.getItem(STORAGE_KEY))

    return {
      token: saved?.token ?? null,
      userId: saved?.userId ?? null,
      role: saved?.role ?? null,
      communityId: saved?.communityId ?? null,
      mustChangePassword: saved?.mustChangePassword ?? false,
      communities: saved?.communities ?? [],
      // Kept so a forced password change can re-authenticate afterwards.
      lastEmail: saved?.lastEmail ?? null,
    }
  },

  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    canViewPlans: (state) => ['root', 'admin', 'layout_designer', 'planner'].includes(state.role),
    canManageGroups: (state) => ['root', 'admin', 'planner'].includes(state.role),
    canManageLayout: (state) => ['root', 'admin', 'layout_designer'].includes(state.role),
    canBroadcast: (state) => ['root', 'admin', 'planner'].includes(state.role),
    // Provisioning accounts is an administrative act: a planner coordinates an event but does
    // not decide who exists.
    canMassAdd: (state) => ['root', 'admin'].includes(state.role),
  },

  actions: {
    api() {
      return createApiClient({
        getToken: () => this.token,
        onUnauthorized: () => this.clear(),
      })
    },

    persist() {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          token: this.token,
          userId: this.userId,
          role: this.role,
          communityId: this.communityId,
          mustChangePassword: this.mustChangePassword,
          communities: this.communities,
          lastEmail: this.lastEmail,
        }),
      )
    },

    applySession(payload) {
      this.token = payload.token
      this.role = payload.role
      this.communityId = payload.communityId
      this.mustChangePassword = payload.mustChangePassword === true
      // The API does not return the user id on login, so take it from the token's subject.
      this.userId = decodeSubject(payload.token)
      this.persist()
    },

    /**
     * @returns {Promise<{ok: true} | {ok: false, needsCommunity: true, communities: string[]} | {ok: false, error: string}>}
     */
    async login(email, password, communityId) {
      try {
        const body = { email, password, ...(communityId ? { communityId } : {}) }
        const { data } = await this.api().post('/auth/login', body)
        this.lastEmail = email
        this.applySession(data)
        return { ok: true }
      } catch (error) {
        const response = error?.response

        // Belongs to several communities and did not say which: the API answers 400 with the
        // list, so the view can show a picker rather than a dead end.
        if (response?.status === 400 && Array.isArray(response.data?.communities)) {
          this.communities = response.data.communities
          this.persist()
          return { ok: false, needsCommunity: true, communities: response.data.communities }
        }

        return { ok: false, error: response?.data?.error ?? 'Could not sign in' }
      }
    },

    async changePassword(currentPassword, newPassword) {
      await this.api().post('/auth/password', { currentPassword, newPassword })
      this.mustChangePassword = false
      this.persist()
    },

    async switchCommunity(communityId) {
      if (!this.lastEmail) return { ok: false, error: 'Please sign in again' }
      return { ok: false, needsPassword: true, communityId }
    },

    clear() {
      this.token = null
      this.userId = null
      this.role = null
      this.communityId = null
      this.mustChangePassword = false
      localStorage.removeItem(STORAGE_KEY)
    },
  },
})

function safeParse(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Read `sub` from the JWT payload without verifying it — the server does the verifying. */
function decodeSubject(token) {
  try {
    const payload = token.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json).sub ?? null
  } catch {
    return null
  }
}
