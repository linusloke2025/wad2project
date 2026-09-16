<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { describeError } from '@/api/client.js'
import { createSocket } from '@/api/socket.js'
import { useAuthStore } from '@/stores/auth.js'

/**
 * The live board.
 *
 * Shows where each group is and what it is doing, and — for the groups the viewer may speak for
 * — lets them report. The scoped snapshot from `GET /live` doubles as the reportable set: an
 * ordinary user's snapshot contains only the groups they lead, while a planning role's contains
 * all of them, which is exactly the same rule the socket enforces.
 *
 * Delivery is realtime, but correctness does not depend on it. On every (re)connect the board
 * resyncs over HTTP, so a dropped socket during a parade leaves a stale view for a moment rather
 * than a permanently wrong one.
 */
const props = defineProps({ eventId: { type: String, required: true } })

const auth = useAuthStore()

const groups = ref([])
const announcements = ref([])
const announcementsError = ref('')
const connected = ref(false)
const error = ref('')
const busy = ref(false)

// Which group a response is sent on behalf of. A lead usually has one; a planner may cover many.
const respondAsGroupId = ref('')

const STATUSES = [
  { value: 'pending', label: 'Pending', variant: 'secondary' },
  { value: 'moving', label: 'Moving', variant: 'primary' },
  { value: 'arrived', label: 'Arrived', variant: 'success' },
  { value: 'delayed', label: 'Delayed', variant: 'warning' },
]

const RESPONSES = [
  { value: 'acknowledged', label: 'Acknowledged', variant: 'success' },
  { value: 'need_help', label: 'Need help', variant: 'warning' },
  { value: 'cant_comply', label: "Can't comply", variant: 'danger' },
]

let socket = null

const reportableGroups = computed(() => groups.value)

const canBroadcast = computed(() => auth.canBroadcast)
const broadcastDraft = ref('')

function statusMeta(event) {
  return STATUSES.find((entry) => entry.value === event.status) ?? { label: 'No report', variant: 'light' }
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString() : '—'
}

/** Pull the current board over HTTP. Also used to resync after a reconnect. */
async function resync() {
  try {
    const { data } = await auth.api().get(`/events/${props.eventId}/live`)
    groups.value = data.groups ?? []
    if (!respondAsGroupId.value && reportableGroups.value.length > 0) {
      respondAsGroupId.value = reportableGroups.value[0].groupId
    }
  } catch (requestError) {
    error.value = describeError(requestError)
  }
}

async function loadAnnouncements() {
  announcementsError.value = ''
  try {
    const { data } = await auth.api().get(`/events/${props.eventId}/announcements`)
    announcements.value = data.announcements ?? []
  } catch (requestError) {
    announcementsError.value = describeError(requestError)
  }
}

function mergeGroup(update) {
  const index = groups.value.findIndex((entry) => entry.groupId === update.groupId)
  if (index === -1) {
    groups.value = [...groups.value, { groupId: update.groupId, status: null, position: null, ...update }]
    return
  }
  groups.value[index] = { ...groups.value[index], ...update }
}

function connect() {
  socket = createSocket({ token: auth.token })

  socket.on('connect', () => {
    connected.value = true
    // Join the room, then pull the board over HTTP. The HTTP endpoint is the authoritative,
    // scoped view; taking the board from the socket ack instead would mean implementing the
    // scoping rules twice, and an unscoped reply would replace a correct board with an empty one.
    socket.emit('event:join', { eventId: props.eventId }, () => {
      resync()
    })
  })

  socket.on('disconnect', () => {
    connected.value = false
  })

  socket.on('status:changed', (update) => mergeGroup(update))
  socket.on('position:changed', (update) => mergeGroup(update))

  socket.on('announcement:created', (announcement) => {
    announcements.value = [announcement, ...announcements.value]
  })
}

/** Report a manual status. This is the indoor path, where GPS is unavailable. */
async function report(groupId, status) {
  busy.value = true
  error.value = ''
  try {
    await new Promise((resolve, reject) => {
      socket.emit('status:update', { eventId: props.eventId, groupId, status }, (ack) => {
        // The server re-checks authority on every update; surface its refusal rather than
        // assuming the click worked.
        if (ack?.ok) resolve()
        else reject(new Error(ack?.error ?? 'Could not report the status'))
      })
    })
  } catch (reportError) {
    error.value = reportError.message
  } finally {
    busy.value = false
  }
}

/**
 * Share the device position.
 *
 * Wrapped because geolocation is unavailable indoors, which is precisely the case the manual
 * status path above exists for — so a failure here is reported and the board stays usable.
 */
function sharePosition(groupId) {
  error.value = ''

  if (!navigator.geolocation) {
    error.value = 'This device cannot share a position. Report a status instead.'
    return
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      socket.emit(
        'position:update',
        {
          eventId: props.eventId,
          groupId,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        },
        (ack) => {
          if (!ack?.ok) error.value = ack?.error ?? 'Could not share the position'
        },
      )
    },
    () => {
      // Denied, unavailable, or indoors. Not a dead end: the status buttons still work.
      error.value = 'No position available here — report a status instead.'
    },
    { enableHighAccuracy: true, timeout: 5000 },
  )
}

async function respond(announcementId, status) {
  announcementsError.value = ''
  try {
    await auth.api().post(`/events/${props.eventId}/announcements/${announcementId}/ack`, {
      groupId: respondAsGroupId.value,
      status,
    })
    await loadAnnouncements()
  } catch (requestError) {
    announcementsError.value = describeError(requestError)
  }
}

async function broadcast() {
  if (broadcastDraft.value.trim() === '') return
  announcementsError.value = ''
  try {
    await auth.api().post(`/events/${props.eventId}/announcements`, { body: broadcastDraft.value })
    broadcastDraft.value = ''
    await loadAnnouncements()
  } catch (requestError) {
    announcementsError.value = describeError(requestError)
  }
}

onMounted(async () => {
  await resync()
  await loadAnnouncements()
  connect()
})

onBeforeUnmount(() => {
  socket?.disconnect()
  socket = null
})
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="h6 card-title mb-0">Live board</h2>
        <span
          class="badge"
          :class="connected ? 'text-bg-success' : 'text-bg-secondary'"
          data-testid="live-connection"
        >
          {{ connected ? 'live' : 'reconnecting' }}
        </span>
      </div>

      <div v-if="error" class="alert alert-warning py-2 small" role="alert" data-testid="live-error">
        {{ error }}
      </div>

      <p v-if="groups.length === 0" class="text-body-secondary small mb-0" data-testid="live-empty">
        No groups are reporting yet.
      </p>

      <ul v-else class="list-group list-group-flush" data-testid="live-groups">
        <li
          v-for="group in groups"
          :key="group.groupId"
          class="list-group-item px-0"
          data-testid="live-group"
          :data-group-name="group.name"
        >
          <div class="d-flex justify-content-between align-items-center gap-2">
            <span class="small fw-semibold" data-testid="live-group-name">{{ group.name }}</span>
            <span class="text-body-secondary small">updated {{ formatTime(group.updatedAt) }}</span>
          </div>

          <div class="d-flex align-items-center gap-2 mt-1">
            <span
              class="badge"
              :class="`text-bg-${statusMeta(group).variant === 'light' ? 'light' : statusMeta(group).variant}`"
              data-testid="live-status"
            >
              {{ statusMeta(group).label }}
            </span>
            <span v-if="group.position" class="text-body-secondary small" data-testid="live-position">
              {{ group.position.latitude.toFixed(5) }}, {{ group.position.longitude.toFixed(5) }}
            </span>
          </div>

          <div class="d-flex flex-wrap gap-1 mt-2">
            <button
              v-for="option in STATUSES"
              :key="option.value"
              class="btn btn-sm"
              :class="`btn-outline-${option.variant}`"
              type="button"
              :disabled="busy"
              :data-testid="`report-${option.value}`"
              @click="report(group.groupId, option.value)"
            >
              {{ option.label }}
            </button>
            <button
              class="btn btn-sm btn-outline-dark"
              type="button"
              data-testid="share-position"
              @click="sharePosition(group.groupId)"
            >
              Share position
            </button>
          </div>
        </li>
      </ul>

      <hr />

      <div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="h6 card-title mb-0">Announcements</h2>
      </div>

      <div v-if="announcementsError" class="alert alert-danger py-2 small" role="alert" data-testid="announcement-error">
        {{ announcementsError }}
      </div>

      <form v-if="canBroadcast" class="mb-3" @submit.prevent="broadcast">
        <label class="form-label small" for="broadcast">Broadcast to every group</label>
        <div class="input-group">
          <input
            id="broadcast"
            v-model="broadcastDraft"
            class="form-control"
            placeholder="e.g. Group 3 delayed 10 minutes — hold position"
            data-testid="broadcast-input"
          />
          <button class="btn btn-primary" type="submit" data-testid="broadcast-send">Send</button>
        </div>
        <div class="form-text">One-way. Leads answer with a fixed signal, never text.</div>
      </form>

      <p v-if="announcements.length === 0" class="text-body-secondary small mb-0" data-testid="live-no-announcements">
        Nothing announced yet.
      </p>

      <template v-else>
        <div v-if="reportableGroups.length > 1" class="mb-2">
          <label class="form-label small mb-1" for="respondAs">Respond as</label>
          <select id="respondAs" v-model="respondAsGroupId" class="form-select form-select-sm" data-testid="respond-as">
            <option v-for="group in reportableGroups" :key="group.groupId" :value="group.groupId">
              {{ group.groupId }}
            </option>
          </select>
        </div>

        <ul class="list-group list-group-flush" data-testid="live-announcements">
          <li v-for="item in announcements" :key="item.id" class="list-group-item px-0">
            <div class="small">{{ item.body }}</div>

            <div class="text-body-secondary small mt-1" data-testid="live-ack-tally">
              {{ item.acknowledgements?.counts?.acknowledged ?? 0 }} of
              {{ item.acknowledgements?.totalGroups ?? 0 }} acknowledged
              <span v-if="item.acknowledgements?.awaitingResponseGroupIds?.length" class="badge text-bg-light text-dark ms-1">
                {{ item.acknowledgements.awaitingResponseGroupIds.length }} not answered
              </span>
            </div>

            <!--
              A fixed set of signals, not a reply box: a text field would make this chat, which
              is the thing being replaced.
            -->
            <div v-if="reportableGroups.length > 0" class="d-flex flex-wrap gap-1 mt-2">
              <button
                v-for="option in RESPONSES"
                :key="option.value"
                class="btn btn-sm"
                :class="`btn-outline-${option.variant}`"
                type="button"
                :data-testid="`respond-${option.value}`"
                @click="respond(item.id, option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
