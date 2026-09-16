<script setup>
import { computed, onMounted, ref } from 'vue'

import { describeError } from '@/api/client.js'
import { useAuthStore } from '@/stores/auth.js'

/**
 * Groups and their itinerary slots.
 *
 * Emits `changed` after a write so the parent can recompute conflicts — conflicts are derived
 * from assignments, so the parent would otherwise show a stale count and the planner would think
 * their change had no effect.
 */
const props = defineProps({
  eventId: { type: String, required: true },
  zones: { type: Array, default: () => [] },
})

const emit = defineEmits(['changed'])

const auth = useAuthStore()

const groups = ref([])
const assignments = ref([])
const error = ref('')
const busy = ref(false)

const groupName = ref('')
const draft = ref({ groupId: '', zoneId: '', start: '', end: '' })

// Blocked areas and obstacles are not somewhere a group can be scheduled.
const assignableZones = computed(() => props.zones.filter((zone) => (zone.kind ?? 'zone') === 'zone'))

const canManage = computed(() => auth.canManageGroups)

function zoneName(zoneId) {
  return props.zones.find((zone) => zone.id === zoneId)?.name ?? 'Unknown zone'
}

function formatSlot(assignment) {
  const start = new Date(assignment.start)
  const end = new Date(assignment.end)
  return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`
}

async function load() {
  error.value = ''
  try {
    const api = auth.api()
    const [groupResponse, assignmentResponse] = await Promise.all([
      api.get(`/events/${props.eventId}/groups`),
      api.get(`/events/${props.eventId}/assignments`),
    ])
    groups.value = groupResponse.data.groups ?? []
    assignments.value = assignmentResponse.data.assignments ?? []
  } catch (requestError) {
    error.value = describeError(requestError)
  }
}

async function addGroup() {
  if (groupName.value.trim() === '') return
  busy.value = true
  error.value = ''
  try {
    await auth.api().post(`/events/${props.eventId}/groups`, { name: groupName.value })
    groupName.value = ''
    await load()
    emit('changed')
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    busy.value = false
  }
}

async function addAssignment() {
  error.value = ''

  if (!draft.value.groupId || !draft.value.zoneId || !draft.value.start || !draft.value.end) {
    error.value = 'Choose a group, a zone and both times.'
    return
  }

  busy.value = true
  try {
    await auth.api().post(`/events/${props.eventId}/assignments`, {
      groupId: draft.value.groupId,
      zoneId: draft.value.zoneId,
      // datetime-local gives a local wall-clock string; toISOString carries the offset so the
      // server stores an unambiguous instant.
      start: new Date(draft.value.start).toISOString(),
      end: new Date(draft.value.end).toISOString(),
    })
    draft.value = { groupId: '', zoneId: '', start: '', end: '' }
    await load()
    emit('changed')
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="h6 card-title mb-0">Groups and schedule</h2>
        <span class="badge text-bg-light text-dark" data-testid="group-count">{{ groups.length }}</span>
      </div>

      <div v-if="error" class="alert alert-danger py-2 small" role="alert" data-testid="schedule-error">
        {{ error }}
      </div>

      <p v-if="groups.length === 0" class="text-body-secondary small" data-testid="no-groups">
        No groups yet.
      </p>

      <ul v-else class="list-group list-group-flush mb-3" data-testid="group-list">
        <li v-for="group in groups" :key="group.id" class="list-group-item px-0">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div class="small fw-semibold" data-testid="group-name">{{ group.name }}</div>
            <span v-if="group.leadUserId" class="badge text-bg-info">lead assigned</span>
          </div>

          <ul v-if="assignments.filter((a) => a.groupId === group.id).length" class="list-unstyled small text-body-secondary mb-0 mt-1">
            <li v-for="slot in assignments.filter((a) => a.groupId === group.id)" :key="slot.id" data-testid="assignment-slot">
              {{ zoneName(slot.zoneId) }} · {{ formatSlot(slot) }}
            </li>
          </ul>
          <div v-else class="small text-body-secondary mt-1" data-testid="group-unscheduled">No slots scheduled</div>
        </li>
      </ul>

      <template v-if="canManage">
        <h3 class="h6">Add a group</h3>
        <form class="row g-2 align-items-end mb-4" @submit.prevent="addGroup">
          <div class="col-12 col-sm-8">
            <label class="form-label small mb-1" for="groupName">Group name</label>
            <input
              id="groupName"
              v-model="groupName"
              class="form-control"
              :disabled="busy"
              data-testid="group-name-input"
            />
          </div>
          <div class="col-12 col-sm-4">
            <button class="btn btn-outline-primary w-100" type="submit" :disabled="busy" data-testid="add-group">
              Add group
            </button>
          </div>
        </form>

        <h3 class="h6">Schedule a movement</h3>
        <!--
          Inputs are disabled while a save is in flight. The form is cleared on success, so
          without this a field edited mid-save would be wiped when the response lands.
        -->
        <form class="row g-2" @submit.prevent="addAssignment">
          <div class="col-12 col-sm-6 col-lg-3">
            <label class="form-label small mb-1" for="assignGroup">Group</label>
            <select id="assignGroup" v-model="draft.groupId" class="form-select" :disabled="busy" data-testid="assign-group">
              <option value="">Choose…</option>
              <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </div>

          <div class="col-12 col-sm-6 col-lg-3">
            <label class="form-label small mb-1" for="assignZone">Zone</label>
            <select id="assignZone" v-model="draft.zoneId" class="form-select" :disabled="busy" data-testid="assign-zone">
              <option value="">Choose…</option>
              <option v-for="zone in assignableZones" :key="zone.id" :value="zone.id">{{ zone.name }}</option>
            </select>
          </div>

          <div class="col-6 col-lg-3">
            <label class="form-label small mb-1" for="assignStart">From</label>
            <input id="assignStart" v-model="draft.start" type="datetime-local" class="form-control" :disabled="busy" data-testid="assign-start" />
          </div>

          <div class="col-6 col-lg-3">
            <label class="form-label small mb-1" for="assignEnd">To</label>
            <input id="assignEnd" v-model="draft.end" type="datetime-local" class="form-control" :disabled="busy" data-testid="assign-end" />
          </div>

          <div class="col-12">
            <button class="btn btn-primary mt-2 w-100 w-md-auto" type="submit" :disabled="busy" data-testid="add-assignment">
              Add to schedule
            </button>
          </div>
        </form>
      </template>
    </div>
  </div>
</template>
