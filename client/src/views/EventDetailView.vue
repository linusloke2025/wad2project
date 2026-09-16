<script setup>
import { computed, onMounted, ref } from 'vue'

import { describeError } from '@/api/client.js'
import { useAuthStore } from '@/stores/auth.js'
import PlanSchedule from '@/components/PlanSchedule.vue'
import LiveBoard from '@/components/LiveBoard.vue'
import BottleneckReport from '@/components/BottleneckReport.vue'
import LayoutDesigner from '@/components/LayoutDesigner.vue'

const props = defineProps({ eventId: { type: String, required: true } })

const auth = useAuthStore()

const event = ref(null)
const layout = ref(null)
const conflicts = ref([])
const unresolvedCount = ref(0)
const loading = ref(true)
const error = ref('')

// Which panels this role may even ask for. The server refuses regardless; this only avoids
// showing a role a panel that would 403.
const canViewPlans = computed(() => auth.canViewPlans)
const canManageLayout = computed(() => auth.canManageLayout)

const conflictLabels = {
  zone_double_booking: 'Two groups hold the same zone at overlapping times',
  tight_transition: 'Too little time to walk between these zones',
  blocked_area: 'A blocked area is used or crossed',
  unscheduled_group: 'A group has no assignment during the event',
}

async function load() {
  loading.value = true
  error.value = ''

  try {
    const api = auth.api()
    const eventResponse = await api.get(`/events/${props.eventId}`)
    event.value = eventResponse.data

    if (canViewPlans.value) {
      const [layoutResponse, conflictResponse] = await Promise.all([
        api.get(`/events/${props.eventId}/layout`),
        api.get(`/events/${props.eventId}/conflicts`),
      ])
      layout.value = layoutResponse.data
      conflicts.value = conflictResponse.data.conflicts ?? []
      unresolvedCount.value = conflictResponse.data.unresolvedCount ?? 0
    }
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    loading.value = false
  }
}

async function reloadConflicts() {
  // Conflicts are derived from assignments, so any change to the schedule invalidates the count
  // shown beside them.
  try {
    const { data } = await auth.api().get(`/events/${props.eventId}/conflicts`)
    conflicts.value = data.conflicts ?? []
    unresolvedCount.value = data.unresolvedCount ?? 0
  } catch (requestError) {
    error.value = describeError(requestError)
  }
}

/** A new or changed shape invalidates the plan, the shape list and the conflicts together. */
async function reloadLayout() {
  try {
    const [layoutResponse, conflictResponse] = await Promise.all([
      auth.api().get(`/events/${props.eventId}/layout`),
      auth.api().get(`/events/${props.eventId}/conflicts`),
    ])
    layout.value = layoutResponse.data
    conflicts.value = conflictResponse.data.conflicts ?? []
    unresolvedCount.value = conflictResponse.data.unresolvedCount ?? 0
  } catch (requestError) {
    error.value = describeError(requestError)
  }
}

function formatWindow() {
  if (!event.value?.start || !event.value?.end) return 'No scheduled window'
  return `${new Date(event.value.start).toLocaleString()} – ${new Date(event.value.end).toLocaleTimeString()}`
}

onMounted(load)
</script>

<template>
  <div class="container py-4">
    <div v-if="loading" class="text-body-secondary">Loading plan…</div>

    <div v-else-if="error" class="alert alert-danger" role="alert" data-testid="event-error">
      {{ error }}
    </div>

    <template v-else-if="event">
      <nav aria-label="breadcrumb">
        <ol class="breadcrumb small">
          <li class="breadcrumb-item"><router-link to="/">Events</router-link></li>
          <li class="breadcrumb-item active" aria-current="page">{{ event.name }}</li>
        </ol>
      </nav>

      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h1 class="h4 mb-1" data-testid="event-name">{{ event.name }}</h1>
          <p class="text-body-secondary small mb-0">{{ formatWindow() }}</p>
        </div>
        <div>
          <span class="badge text-bg-secondary me-1">{{ event.layoutMode === 'map' ? 'Map layout' : 'Floor plan' }}</span>
          <span class="badge" :class="event.status === 'live' ? 'text-bg-success' : 'text-bg-light text-dark'">
            {{ event.status }}
          </span>
        </div>
      </div>

      <div class="row g-4">
        <!-- Layout -->
        <div v-if="canViewPlans" class="col-12 col-lg-7">
          <div class="card h-100">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <h2 class="h6 card-title mb-0">Layout</h2>
                <span v-if="layout" class="badge text-bg-light text-dark" data-testid="zone-count">
                  {{ layout.zones?.length ?? 0 }} shape(s)
                </span>
              </div>

              <div v-if="layout?.warning" class="alert alert-warning py-2 small" role="alert" data-testid="map-warning">
                {{ layout.warning }}
              </div>

              <!--
                A designer gets the drawing surface; everyone else gets the same layout read-only.
                Both render the shapes from the same data, so the designer sees exactly what the
                planner will.
              -->
              <LayoutDesigner
                v-if="canManageLayout"
                :event-id="eventId"
                :layout-mode="event.layoutMode"
                :layout-image-url="layout?.imageUrl ?? null"
                :zones="layout?.zones ?? []"
                @changed="reloadLayout"
              />

              <div v-else class="layout-surface">
                <img
                  v-if="layout?.imageUrl"
                  :src="layout.imageUrl"
                  alt="Event layout showing zones and blocked areas"
                  data-testid="layout-image"
                />
                <div v-else class="p-4 text-center text-body-secondary small">
                  No layout image yet. A layout designer can place zones and blocked areas.
                </div>
              </div>

              <p v-if="layout?.omittedShapes" class="form-text mb-0" data-testid="omitted-shapes">
                {{ layout.omittedShapes }} shape(s) omitted from the map because the request was too
                large — the plan itself is unaffected.
              </p>
            </div>
          </div>
        </div>

        <!-- Conflicts -->
        <div v-if="canViewPlans" class="col-12 col-lg-5">
          <div class="card h-100">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <h2 class="h6 card-title mb-0">Conflicts</h2>
                <!-- Advisory, never blocking: a planner may proceed knowingly. -->
                <span
                  class="badge"
                  :class="unresolvedCount === 0 ? 'text-bg-success' : 'text-bg-warning'"
                  data-testid="conflict-count"
                >
                  {{ unresolvedCount }}
                </span>
              </div>

              <p v-if="unresolvedCount === 0" class="text-body-secondary small mb-0" data-testid="no-conflicts">
                No conflicts detected on this plan.
              </p>

              <ul v-else class="list-group list-group-flush" data-testid="conflict-list">
                <li v-for="(conflict, index) in conflicts" :key="index" class="list-group-item px-0">
                  <div class="small fw-semibold">{{ conflictLabels[conflict.type] ?? conflict.type }}</div>
                  <div class="text-body-secondary small">
                    <span v-if="conflict.zoneId">Zone {{ conflict.zoneId }}. </span>
                    <span v-if="conflict.gapSeconds !== undefined">
                      {{ conflict.gapSeconds }}s available, {{ Math.round(conflict.walkSeconds) }}s needed
                      <span v-if="conflict.source === 'estimate'" class="badge text-bg-light text-dark ms-1">estimated</span>
                      <span v-else class="badge text-bg-info ms-1">routed</span>
                    </span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- Groups and their itinerary slots -->
        <div v-if="canViewPlans" class="col-12">
          <PlanSchedule :event-id="eventId" :zones="layout?.zones ?? []" @changed="reloadConflicts" />
        </div>

        <!-- Post-event analysis: what the plan predicted versus what actually happened. -->
        <div v-if="canViewPlans" class="col-12">
          <BottleneckReport :event-id="eventId" />
        </div>

        <!--
          The live board is shown to every role, because live.view is granted to all: an
          ordinary group lead needs to see where their group is and to receive announcements.
          Announcements live inside the board rather than in a separate planning-only panel —
          gating them behind a planning role was hiding them from exactly the people meant to
          receive them.
        -->
        <div class="col-12">
          <LiveBoard :event-id="eventId" />
        </div>
      </div>
    </template>
  </div>
</template>
