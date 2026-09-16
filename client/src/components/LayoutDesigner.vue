<script setup>
import { computed, ref } from 'vue'

import { describeError } from '@/api/client.js'
import { useAuthStore } from '@/stores/auth.js'

/**
 * The layout designer's surface.
 *
 * Zones are placed by tapping vertices directly on the floor plan, then naming and saving the
 * shape. Tapping vertices rather than drawing freehand keeps every zone an exact polygon, which
 * is what makes the geometry checks — overlaps, blocked areas, transit paths — mean anything.
 *
 * Coordinates are converted into the image's own pixel space before being stored, so a zone
 * placements survive the plan being displayed at a different size on a phone than on a laptop.
 * Storing screen coordinates instead would make every plan resolution-dependent.
 */
const props = defineProps({
  eventId: { type: String, required: true },
  layoutMode: { type: String, default: 'plan' },
  layoutImageUrl: { type: String, default: null },
  zones: { type: Array, default: () => [] },
})

const emit = defineEmits(['changed'])

const auth = useAuthStore()

// Fallback surface size for a plan with no image yet, and the default zoom for one.
const FALLBACK_WIDTH = 1000
const FALLBACK_HEIGHT = 700
const DEFAULT_ZOOM = 17

const SHAPE_KINDS = [
  { value: 'zone', label: 'Zone' },
  { value: 'blocked', label: 'Blocked area' },
  { value: 'obstacle', label: 'Obstacle' },
  { value: 'stairs', label: 'Stairs' },
  { value: 'lift', label: 'Lift' },
]

const surface = ref(null)
const image = ref(null)

const draft = ref([])
const shapeName = ref('')
const shapeKind = ref('zone')
const error = ref('')
const notice = ref('')
const busy = ref(false)

const canManage = computed(() => auth.canManageLayout)
const isMapLayout = computed(() => props.layoutMode === 'map')

/** Natural pixel size of whatever is being drawn on, used as the coordinate space. */
const surfaceWidth = computed(() => image.value?.naturalWidth || FALLBACK_WIDTH)
const surfaceHeight = computed(() => image.value?.naturalHeight || FALLBACK_HEIGHT)

const draftPoints = computed(() => draft.value.map(([x, y]) => `${x},${y}`).join(' '))

function onImageLoad(event) {
  image.value = event.target
}

/** Translate a click into the surface's own pixel space. */
function onSurfaceClick(event) {
  if (!canManage.value) return

  const bounds = surface.value?.getBoundingClientRect()
  if (!bounds || bounds.width === 0 || bounds.height === 0) return

  const x = Math.round(((event.clientX - bounds.left) / bounds.width) * surfaceWidth.value)
  const y = Math.round(((event.clientY - bounds.top) / bounds.height) * surfaceHeight.value)

  draft.value = [...draft.value, [x, y]]
}

function clearDraft() {
  draft.value = []
  shapeName.value = ''
}

async function saveShape() {
  error.value = ''
  notice.value = ''

  if (draft.value.length < 3) {
    error.value = 'A shape needs at least three corners.'
    return
  }
  if (shapeName.value.trim() === '') {
    error.value = 'Give the shape a name so planners can recognise it.'
    return
  }

  busy.value = true
  try {
    await auth.api().post(`/events/${props.eventId}/zones`, {
      name: shapeName.value.trim(),
      kind: shapeKind.value,
      polygon: draft.value,
    })
    notice.value = `Saved ${shapeName.value.trim()}.`
    clearDraft()
    emit('changed')
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    busy.value = false
  }
}

async function uploadImage(event) {
  const file = event.target.files?.[0]
  if (!file) return

  error.value = ''
  notice.value = ''
  busy.value = true

  try {
    const form = new FormData()
    form.append('image', file)
    // Sent as multipart rather than as base64 in JSON: it avoids inflating the payload by a
    // third and keeps the body limit where it is for everything else.
    await auth.api().post(`/events/${props.eventId}/layout/image`, form)
    notice.value = 'Floor plan uploaded.'
    emit('changed')
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    busy.value = false
    // Allow re-uploading the same filename, which the browser would otherwise ignore.
    event.target.value = ''
  }
}
</script>

<template>
  <div>
    <div v-if="error" class="alert alert-danger py-2 small" role="alert" data-testid="designer-error">
      {{ error }}
    </div>
    <div v-if="notice" class="alert alert-success py-2 small" role="status" data-testid="designer-notice">
      {{ notice }}
    </div>

    <!-- Upload is only offered for a Plan layout: a Map layout is generated from OneMap. -->
    <div v-if="canManage && !isMapLayout" class="mb-3">
      <label class="form-label small" for="layoutUpload">Floor plan image</label>
      <input
        id="layoutUpload"
        type="file"
        accept="image/*"
        class="form-control"
        :disabled="busy"
        data-testid="layout-upload"
        @change="uploadImage"
      />
      <div class="form-text">PNG or JPEG, up to 5MB. Zones are drawn over it in its own pixels.</div>
    </div>

    <!--
      The surface is a click target rather than a canvas: tapping vertices is enough to capture
      an exact polygon, and it works with a finger on a phone, which freehand drawing does not.
    -->
    <div
      ref="surface"
      class="layout-surface"
      :class="{ 'layout-surface-drawing': canManage }"
      data-testid="layout-surface"
      @click="onSurfaceClick"
    >
      <img
        v-if="layoutImageUrl"
        :src="layoutImageUrl"
        alt="Event layout showing zones and blocked areas"
        data-testid="layout-image"
        @load="onImageLoad"
      />
      <div v-else class="p-4 text-center text-body-secondary small">
        <template v-if="isMapLayout">The map is generated from OneMap for this event.</template>
        <template v-else-if="canManage">
          Upload a floor plan above, then tap to place the corners of a shape. You can place shapes
          on the blank surface first if you prefer.
        </template>
        <template v-else>No layout image has been uploaded yet.</template>
      </div>

      <!-- Existing shapes and the draft share one overlay, in surface pixel coordinates. -->
      <svg
        class="layout-overlay"
        :viewBox="`0 0 ${surfaceWidth} ${surfaceHeight}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          v-for="zone in zones"
          :key="zone.id"
          :points="zone.polygon.map(([x, y]) => `${x},${y}`).join(' ')"
          :class="zone.kind === 'blocked' ? 'shape-blocked' : 'shape-zone'"
        />
        <polygon v-if="draft.length > 1" :points="draftPoints" class="shape-draft" />
        <circle v-for="([x, y], index) in draft" :key="index" :cx="x" :cy="y" r="4" class="shape-vertex" />
      </svg>
    </div>

    <div v-if="canManage" class="mt-3">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="small text-body-secondary" data-testid="draft-vertex-count">
          {{ draft.length }} corner(s) placed
        </span>
        <button
          class="btn btn-sm btn-outline-secondary"
          type="button"
          :disabled="draft.length === 0"
          data-testid="clear-draft"
          @click="clearDraft"
        >
          Clear
        </button>
      </div>

      <div class="row g-2 align-items-end">
        <div class="col-12 col-sm-5">
          <label class="form-label small mb-1" for="shapeName">Name</label>
          <input id="shapeName" v-model="shapeName" class="form-control form-control-sm" data-testid="shape-name" />
        </div>
        <div class="col-8 col-sm-4">
          <label class="form-label small mb-1" for="shapeKind">Kind</label>
          <select id="shapeKind" v-model="shapeKind" class="form-select form-select-sm" data-testid="shape-kind">
            <option v-for="kind in SHAPE_KINDS" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
          </select>
        </div>
        <div class="col-4 col-sm-3">
          <button
            class="btn btn-sm btn-primary w-100"
            type="button"
            :disabled="busy"
            data-testid="save-shape"
            @click="saveShape"
          >
            Save
          </button>
        </div>
      </div>

      <ul v-if="zones.length" class="list-unstyled small text-body-secondary mt-3 mb-0" data-testid="shape-list">
        <li v-for="zone in zones" :key="zone.id" data-testid="shape-row">
          {{ zone.name }} · {{ zone.kind ?? 'zone' }} · {{ zone.polygon.length }} corners
        </li>
      </ul>
    </div>
  </div>
</template>
