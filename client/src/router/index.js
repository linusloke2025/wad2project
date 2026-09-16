import { createRouter, createWebHistory } from 'vue-router'

import { useAuthStore } from '@/stores/auth.js'
import LoginView from '@/views/LoginView.vue'
import EventsView from '@/views/EventsView.vue'
import EventDetailView from '@/views/EventDetailView.vue'

const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/', name: 'events', component: EventsView },
  { path: '/events/:eventId', name: 'event', component: EventDetailView, props: true },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// One guard for the whole app, rather than a check in every view. The server refuses
// unauthorised actions regardless — this only decides what the user is shown.
router.beforeEach((to) => {
  const auth = useAuthStore()

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.meta.public && auth.isAuthenticated) {
    return { name: 'events' }
  }
  return true
})

export default router
