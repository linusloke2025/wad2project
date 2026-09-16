<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const email = ref(auth.lastEmail ?? '')
const password = ref('')
const communityId = ref('')
const error = ref('')
const busy = ref(false)

// Shown when the account belongs to several communities: the role — and therefore every
// permission — differs per community, so the API refuses to guess which one is meant.
const needsCommunity = ref(false)
const communities = ref([])

// Shown when the account is still on an admin-issued temporary password.
const newPassword = ref('')
const confirmPassword = ref('')

async function submit() {
  error.value = ''
  busy.value = true

  const result = await auth.login(email.value, password.value, communityId.value || undefined)

  busy.value = false

  if (result.ok) {
    await afterSignIn()
    return
  }
  if (result.needsCommunity) {
    needsCommunity.value = true
    communities.value = result.communities
    // Preselect the only sensible default so the common case is one click.
    communityId.value = result.communities[0] ?? ''
    return
  }
  error.value = result.error
}

async function submitPasswordChange() {
  error.value = ''

  if (newPassword.value !== confirmPassword.value) {
    error.value = 'The two passwords do not match.'
    return
  }

  busy.value = true
  try {
    await auth.changePassword(password.value, newPassword.value)
    // Ownership of the account is now the user's, so let them in.
    password.value = newPassword.value
    await afterSignIn()
  } catch (requestError) {
    error.value = requestError?.response?.data?.error ?? 'Could not change the password.'
  } finally {
    busy.value = false
  }
}

async function afterSignIn() {
  if (auth.mustChangePassword) return
  await router.push(route.query.redirect ?? { name: 'events' })
}
</script>

<template>
  <div class="container py-4 py-md-5">
    <div class="row justify-content-center">
      <div class="col-12 col-sm-10 col-md-7 col-lg-5">
        <h1 class="h3 mb-1">Event Coordination</h1>
        <p class="text-body-secondary mb-4">Sign in to plan and track group movements.</p>

        <div v-if="error" class="alert alert-danger" role="alert" data-testid="login-error">
          {{ error }}
        </div>

        <!-- Forced first-login change: everything else is refused until the temporary
             password in the .env/README goes away. -->
        <form v-if="auth.mustChangePassword" class="card" @submit.prevent="submitPasswordChange">
          <div class="card-body">
            <h2 class="h5 card-title">Choose a new password</h2>
            <p class="text-body-secondary small">
              This account is still using an admin-issued temporary password.
            </p>

            <div class="mb-3">
              <label class="form-label" for="newPassword">New password</label>
              <input
                id="newPassword"
                v-model="newPassword"
                type="password"
                class="form-control"
                autocomplete="new-password"
                data-testid="new-password"
                required
              />
              <div class="form-text">At least 8 characters.</div>
            </div>

            <div class="mb-3">
              <label class="form-label" for="confirmPassword">Confirm new password</label>
              <input
                id="confirmPassword"
                v-model="confirmPassword"
                type="password"
                class="form-control"
                autocomplete="new-password"
                data-testid="confirm-password"
                required
              />
            </div>

            <button class="btn btn-primary w-100" type="submit" :disabled="busy" data-testid="change-password">
              Save and continue
            </button>
          </div>
        </form>

        <form v-else class="card" @submit.prevent="submit">
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label" for="email">Email</label>
              <input
                id="email"
                v-model="email"
                type="email"
                class="form-control"
                autocomplete="username"
                inputmode="email"
                data-testid="email"
                required
              />
            </div>

            <div class="mb-3">
              <label class="form-label" for="password">Password</label>
              <input
                id="password"
                v-model="password"
                type="password"
                class="form-control"
                autocomplete="current-password"
                data-testid="password"
                required
              />
            </div>

            <div v-if="needsCommunity" class="mb-3">
              <label class="form-label" for="community">Community</label>
              <select id="community" v-model="communityId" class="form-select" data-testid="community">
                <option v-for="id in communities" :key="id" :value="id">{{ id }}</option>
              </select>
              <div class="form-text">This account belongs to more than one community.</div>
            </div>

            <button class="btn btn-primary w-100" type="submit" :disabled="busy" data-testid="sign-in">
              {{ busy ? 'Signing in…' : 'Sign in' }}
            </button>
          </div>
        </form>

        <p class="text-body-secondary small mt-3 mb-0">
          Accounts are created by an administrator — there is no public sign-up.
        </p>
      </div>
    </div>
  </div>
</template>
