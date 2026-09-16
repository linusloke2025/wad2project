<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { describeError } from '@/api/client.js'
import { useAuthStore } from '@/stores/auth.js'
import MemberImport from '@/components/MemberImport.vue'

const auth = useAuthStore()
const router = useRouter()

const events = ref([])
const loading = ref(true)
const error = ref('')

const showCreate = ref(false)
const draft = ref({ name: '', start: '', end: '', layoutMode: 'plan', metresPerPixel: 0.1, latitude: '', longitude: '' })
const createError = ref('')
const creating = ref(false)

// Only root and admin may create or delete an event; a planner may edit one they coordinate.
const canCreate = computed(() => ['root', 'admin'].includes(auth.role))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await auth.api().get('/events')
    events.value = data.events ?? []
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    loading.value = false
  }
}

async function createEvent() {
  createError.value = ''
  creating.value = true

  const payload = {
    name: draft.value.name,
    start: draft.value.start || null,
    end: draft.value.end || null,
    layoutMode: draft.value.layoutMode,
    metresPerPixel: Number(draft.value.metresPerPixel) || 1,
  }
  // Only Map layouts need a centre; sending blanks would store nulls, which the layout
  // service already treats as "no coordinates" and degrades from.
  if (draft.value.layoutMode === 'map') {
    payload.latitude = Number(draft.value.latitude)
    payload.longitude = Number(draft.value.longitude)
  }

  try {
    const { data } = await auth.api().post('/events', payload)
    showCreate.value = false
    draft.value = { name: '', start: '', end: '', layoutMode: 'plan', metresPerPixel: 0.1, latitude: '', longitude: '' }
    router.push({ name: 'event', params: { eventId: data.id } })
  } catch (requestError) {
    createError.value = describeError(requestError)
  } finally {
    creating.value = false
  }
}

function formatWindow(event) {
  if (!event.start || !event.end) return 'No scheduled window yet'
  const start = new Date(event.start)
  const end = new Date(event.end)
  return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`
}

onMounted(load)
</script>

<template>
  <div class="container py-4">
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
      <div>
        <h1 class="h4 mb-0">Events</h1>
        <p class="text-body-secondary small mb-0">Plans for this community.</p>
      </div>

      <button
        v-if="canCreate"
        class="btn btn-primary"
        type="button"
        data-testid="new-event"
        @click="showCreate = !showCreate"
      >
        {{ showCreate ? 'Cancel' : 'New event' }}
      </button>
    </div>

    <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>

    <!-- Community-level onboarding, so it sits above the events rather than inside one. -->
    <MemberImport />

    <form v-if="showCreate" class="card mb-4" @submit.prevent="createEvent">
      <div class="card-body">
        <h2 class="h5 card-title">New event</h2>

        <div v-if="createError" class="alert alert-danger py-2" role="alert">{{ createError }}</div>

        <div class="row g-3">
          <div class="col-12 col-md-6">
            <label class="form-label" for="eventName">Name</label>
            <input id="eventName" v-model="draft.name" class="form-control" data-testid="event-name" required />
          </div>

          <div class="col-12 col-md-3">
            <label class="form-label" for="eventStart">Starts</label>
            <input id="eventStart" v-model="draft.start" type="datetime-local" class="form-control" />
          </div>

          <div class="col-12 col-md-3">
            <label class="form-label" for="eventEnd">Ends</label>
            <input id="eventEnd" v-model="draft.end" type="datetime-local" class="form-control" />
          </div>

          <div class="col-12 col-md-4">
            <label class="form-label" for="layoutMode">Layout</label>
            <select id="layoutMode" v-model="draft.layoutMode" class="form-select" data-testid="layout-mode">
              <option value="plan">Floor plan (uploaded image)</option>
              <option value="map">Map (OneMap basemap)</option>
            </select>
            <div class="form-text">
              Map layouts use real walking times; floor plans estimate from the scale.
            </div>
          </div>

          <div v-if="draft.layoutMode === 'plan'" class="col-12 col-md-4">
            <label class="form-label" for="scale">Metres per pixel</label>
            <input id="scale" v-model="draft.metresPerPixel" type="number" step="0.01" min="0.001" class="form-control" />
            <div class="form-text">How much ground one image pixel covers.</div>
          </div>

          <template v-if="draft.layoutMode === 'map'">
            <div class="col-6 col-md-4">
              <label class="form-label" for="lat">Latitude</label>
              <input id="lat" v-model="draft.latitude" type="number" step="any" class="form-control" required />
            </div>
            <div class="col-6 col-md-4">
              <label class="form-label" for="lng">Longitude</label>
              <input id="lng" v-model="draft.longitude" type="number" step="any" class="form-control" required />
            </div>
          </template>
        </div>

        <button class="btn btn-primary mt-3 w-100 w-md-auto" type="submit" :disabled="creating" data-testid="create-event">
          {{ creating ? 'Creating…' : 'Create event' }}
        </button>
      </div>
    </form>

    <div v-if="loading" class="text-body-secondary">Loading events…</div>

    <div v-else-if="events.length === 0" class="alert alert-info" role="status" data-testid="no-events">
      No events yet. Create one to place zones and start planning movements.
    </div>

    <div v-else class="row g-3">
      <div v-for="event in events" :key="event.id" class="col-12 col-md-6 col-lg-4">
        <div class="card h-100">
          <div class="card-body d-flex flex-column">
            <h2 class="h6 card-title mb-1">{{ event.name }}</h2>
            <p class="text-body-secondary small mb-2">{{ formatWindow(event) }}</p>

            <div class="mb-3">
              <span class="badge text-bg-secondary me-1">{{ event.layoutMode === 'map' ? 'Map' : 'Floor plan' }}</span>
              <span class="badge" :class="event.status === 'live' ? 'text-bg-success' : 'text-bg-light text-dark'">
                {{ event.status }}
              </span>
            </div>

            <router-link
              class="btn btn-outline-primary mt-auto"
              :to="{ name: 'event', params: { eventId: event.id } }"
            >
              Open plan
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
