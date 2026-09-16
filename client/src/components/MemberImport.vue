<script setup>
import { computed, ref } from 'vue'

import { describeError } from '@/api/client.js'
import { useAuthStore } from '@/stores/auth.js'

/**
 * Mass-add members by pasting a CSV roster.
 *
 * Pasting rather than a file input on purpose: a file picker is awkward on a phone, and an admin
 * building a roster is usually copying rows out of a spreadsheet anyway. It also keeps the whole
 * flow testable without driving an OS file dialog.
 *
 * The result panel is the point. A partial import is normal — the API reports rejections per row
 * with their original line numbers so the admin can fix just those and re-paste.
 */
const auth = useAuthStore()

const csv = ref('')
const result = ref(null)
const error = ref('')
const busy = ref(false)

const canImport = computed(() => auth.canMassAdd)

const TEMPLATE = 'name,email,tempPassword\nAlice Tan,alice@example.com,temp1234'

async function submit() {
  error.value = ''
  result.value = null
  busy.value = true

  try {
    const { data } = await auth.api().post('/members/import', { csv: csv.value })
    result.value = data
    // Leave the textarea populated on rejection so the admin can correct the offending rows.
    if (data.errors.length === 0) csv.value = ''
  } catch (requestError) {
    error.value = describeError(requestError)
  } finally {
    busy.value = false
  }
}

function useTemplate() {
  csv.value = TEMPLATE
}
</script>

<template>
  <div v-if="canImport" class="card mb-4">
    <div class="card-body">
      <h2 class="h6 card-title">Add members in bulk</h2>
      <p class="text-body-secondary small">
        Paste a CSV with a <code>name</code>, <code>email</code> and <code>tempPassword</code>
        column. Everyone added starts on a temporary password and must change it at first sign-in.
      </p>

      <div v-if="error" class="alert alert-danger py-2 small" role="alert" data-testid="import-error">
        {{ error }}
      </div>

      <form @submit.prevent="submit">
        <label class="form-label small" for="csv">Roster</label>
        <textarea
          id="csv"
          v-model="csv"
          class="form-control font-monospace"
          rows="5"
          :placeholder="TEMPLATE"
          data-testid="csv-input"
        ></textarea>

        <div class="d-flex flex-wrap gap-2 mt-2">
          <button class="btn btn-primary" type="submit" :disabled="busy" data-testid="import-submit">
            {{ busy ? 'Importing…' : 'Import members' }}
          </button>
          <button class="btn btn-outline-secondary" type="button" :disabled="busy" data-testid="import-template" @click="useTemplate">
            Fill example row
          </button>
        </div>
      </form>

      <div v-if="result" class="mt-3" data-testid="import-result">
        <div class="alert" :class="result.errors.length ? 'alert-warning' : 'alert-success'" role="status">
          {{ result.imported }} member(s) added<span v-if="result.errors.length">,
            {{ result.errors.length }} row(s) skipped</span>.
        </div>

        <!-- Per-row rejections, with the line numbers from the pasted file. -->
        <div v-if="result.errors.length" class="table-responsive">
          <table class="table table-sm mb-0">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Row</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in result.errors" :key="index" data-testid="import-error-row">
                <td>{{ row.line }}</td>
                <td class="font-monospace small">{{ row.raw }}</td>
                <td>{{ row.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
