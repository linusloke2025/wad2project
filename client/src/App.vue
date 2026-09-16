<script setup>
import { useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()
const router = useRouter()

function signOut() {
  auth.clear()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="d-flex flex-column min-vh-100">
    <!--
      navbar-expand-md: collapsed behind a toggler below 768px, which is the mobile-first
      behaviour the brief's responsive criterion expects between 375px and the XL breakpoint.
    -->
    <nav v-if="auth.isAuthenticated" class="navbar navbar-expand-md navbar-dark bg-primary">
      <div class="container-fluid">
        <router-link class="navbar-brand" to="/">Event Coordination</router-link>

        <button
          class="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#mainNav"
          aria-controls="mainNav"
          aria-expanded="false"
          aria-label="Toggle navigation"
        >
          <span class="navbar-toggler-icon"></span>
        </button>

        <div id="mainNav" class="collapse navbar-collapse">
          <ul class="navbar-nav ms-auto align-items-md-center gap-md-3">
            <li class="nav-item">
              <span class="navbar-text small" data-testid="session-summary">
                {{ auth.role }}<span class="d-none d-sm-inline"> · {{ auth.communityId }}</span>
              </span>
            </li>
            <li class="nav-item">
              <button class="btn btn-sm btn-outline-light w-100" type="button" @click="signOut">
                Sign out
              </button>
            </li>
          </ul>
        </div>
      </div>
    </nav>

    <main class="flex-grow-1">
      <router-view />
    </main>
  </div>
</template>
