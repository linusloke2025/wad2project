<script setup>
import { computed, onMounted, ref } from 'vue'

import { describeError } from '@/api/client.js'
import { useAuthStore } from '@/stores/auth.js'

/**
 * The post-event bottleneck report.
 *
 * Read-only, and only meaningful once an event has run — before that every zone is simply
 * unmeasured, which is stated rather than shown as a row of zeroes that would look like the plan
 * was met exactly.
 */
const props = defineProps({ eventId: { type: String, required: true } })

const auth = useAuthStore()

const report = ref(null)
const loading = ref(true)
const error = ref('')

const hasMeasurements = computed(() => (report.value?.totals?.measuredZoneCount ?? 0) > 0)

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—'

  const sign = seconds < 0 ? '-' : ''
  const total = Math.abs(seconds)
  const minutes = Math.floor(total / 60)
  const remainder = total % 60

  if (minutes === 0) return `${sign}${remainder}s`
  return remainder === 0 ? `${sign}${minutes}m` : `${sign}${minutes}m ${remainder}s`
}

/** Positive overrun means the zone took longer than planned, which is the bottleneck. */
function overrunClass(zone) {
  if (!zone.measured) return 'text-body-secondary'
  if (zone.overrunSeconds > 60) return 'text-danger fw-semibold'
  if (zone.overrunSeconds < -60) return 'text-success'
  return 'text-body'
}

async function load() {
  loading.value = true
  error.value = ''

  try {
    const { data } = await auth.api().get(`/events/${props.eventId}/report`)
    report.value = data.report
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <h2 class="h6 card-title mb-0">Bottleneck report</h2>
        <span v-if="report" class="badge text-bg-light text-dark" data-testid="report-summary">
          {{ report.totals.measuredZoneCount }} of {{ report.totals.zoneCount }} zones measured
        </span>
      </div>

      <div v-if="loading" class="text-body-secondary small">Loading report…</div>

      <div v-else-if="error" class="alert alert-danger py-2 small" role="alert" data-testid="report-error">
        {{ error }}
      </div>

      <template v-else-if="report">
        <p v-if="!hasMeasurements" class="text-body-secondary small mb-0" data-testid="report-unmeasured">
          No status reports were recorded, so dwell times cannot be compared against the plan yet.
          Zones still show what was planned.
        </p>

        <p v-else class="text-body-secondary small">
          Actual dwell is measured from the moments leads reported arriving and leaving. The zones
          that ran longest are listed first.
        </p>

        <!-- table-responsive scrolls inside the card, so a wide table never pushes the page. -->
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0" data-testid="report-table">
            <thead>
              <tr>
                <th scope="col">Zone</th>
                <th scope="col" class="text-end">Planned</th>
                <th scope="col" class="text-end">Actual</th>
                <th scope="col" class="text-end">Overrun</th>
                <th scope="col" class="text-end">Clashes</th>
                <th scope="col" class="text-end">Tight</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="zone in report.zones" :key="zone.zoneId" data-testid="report-row">
                <td data-testid="report-zone-name">{{ zone.zoneName }}</td>
                <td class="text-end">{{ formatDuration(zone.plannedDwellSeconds) }}</td>
                <td class="text-end">
                  <span v-if="zone.measured">{{ formatDuration(zone.actualDwellSeconds) }}</span>
                  <span v-else class="text-body-secondary" data-testid="report-unmeasured-zone">not measured</span>
                </td>
                <td class="text-end" :class="overrunClass(zone)" data-testid="report-overrun">
                  {{ zone.measured ? formatDuration(zone.overrunSeconds) : '—' }}
                </td>
                <td class="text-end">{{ zone.overlapCount }}</td>
                <td class="text-end">{{ zone.tightTransitionCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="text-body-secondary small mt-3 mb-0">
          "Clashes" counts overlapping bookings in that zone; "tight" counts transitions with too
          little time to walk.
        </p>
      </template>
    </div>
  </div>
</template>
