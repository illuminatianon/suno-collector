<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from './api.js'

const emit = defineEmits(['saved'])
const userId = ref('')
const ingestMode = ref('owned')
const timeZone = ref('')
const zones = ref([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const success = ref('')
const controller = new AbortController()
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const modeItems = [
  { title: 'Owned — only my songs', value: 'owned' },
  { title: 'Remixed — my songs and referenced sources', value: 'remixed' },
  { title: 'All — every captured song', value: 'all' },
]
const modeDescription = computed(() => ({
  owned: 'Capture only songs whose Suno user ID matches yours.',
  remixed: 'Capture your songs and outside source clips explicitly referenced by your remixes. A source captured before its remix is known needs to be captured again.',
  all: 'Capture every song delivered by the extension, including songs from other users.',
})[ingestMode.value])
const idError = computed(() => {
  const id = userId.value.trim()
  if (!id && ingestMode.value !== 'all') return 'Enter your Suno user ID before saving this mode.'
  if (id && !uuidPattern.test(id)) return 'Enter a UUID in 8-4-4-4-12 format.'
  return ''
})
const canSave = computed(() => !loading.value && !saving.value && !idError.value && !!timeZone.value)

async function loadSettings() {
  loading.value = true
  error.value = ''
  try {
    const settings = await api('/api/settings', controller.signal)
    if (controller.signal.aborted) return
    userId.value = settings.user_id || ''
    ingestMode.value = settings.ingest_mode
    timeZone.value = settings.time_zone
    zones.value = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone'), settings.time_zone])].sort()
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause.message
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}

async function saveSettings() {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    const settings = await api('/api/settings', controller.signal, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId.value.trim() || null, ingest_mode: ingestMode.value, time_zone: timeZone.value }),
    })
    if (controller.signal.aborted) return
    userId.value = settings.user_id || ''
    ingestMode.value = settings.ingest_mode
    timeZone.value = settings.time_zone
    emit('saved', settings)
    success.value = 'Settings saved. New captures now use this policy and timezone.'
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause.message
  } finally {
    if (!controller.signal.aborted) saving.value = false
  }
}

onMounted(loadSettings)
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <main class="settings-page">
    <div class="settings-content">
      <h1>Settings</h1>
      <p class="muted settings-intro">Choose which future captures enter your library and how dates appear. Changing the capture policy does not remove or import songs already stored.</p>
      <div v-if="loading" role="status" aria-busy="true">
        <p>Loading settings…</p>
        <v-progress-linear indeterminate color="primary" aria-label="Loading settings" />
      </div>
      <template v-else>
        <p v-if="error" class="error settings-message" role="alert">{{ error }}</p>
        <form v-if="timeZone" @submit.prevent="saveSettings">
          <section class="settings-section" aria-labelledby="identity-title">
            <h2 id="identity-title">Suno account</h2>
            <v-text-field v-model="userId" label="Suno user ID" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              variant="outlined" :error-messages="userId && idError ? [idError] : []" autocomplete="off" spellcheck="false" />
            <p class="muted">Enter your Suno account UUID, not a song ID. If it’s unset, Owned and Remixed capture pause until you save an ID; the extension keeps queued songs for retry.</p>
            <p class="muted">If you already have songs, use the <RouterLink to="/sql">SQL query</RouterLink> page to find a candidate ID: <code>SELECT user_id, count(*) AS songs FROM songs GROUP BY user_id ORDER BY songs DESC</code>. Check which ID belongs to you before saving.</p>
          </section>
          <section class="settings-section" aria-labelledby="capture-title">
            <h2 id="capture-title">Capture mode</h2>
            <v-select v-model="ingestMode" :items="modeItems" label="Ingest mode" variant="outlined" />
            <p class="muted">{{ modeDescription }}</p>
            <p v-if="!userId.trim() && ingestMode !== 'all'" class="settings-warning" role="status">Captures are paused until you enter your Suno user ID.</p>
          </section>
          <section class="settings-section" aria-labelledby="timezone-title">
            <h2 id="timezone-title">Timezone</h2>
            <v-autocomplete v-model="timeZone" :items="zones" label="Library timezone" variant="outlined" auto-select-first
              :menu-props="{ maxHeight: 280 }" />
            <p class="muted">Dates in the library and timeline follow this timezone. The change takes effect as soon as you save.</p>
          </section>
          <div class="settings-actions">
            <v-btn type="submit" variant="flat" color="primary" :loading="saving" :disabled="!canSave">Save settings</v-btn>
            <span v-if="success" role="status" class="settings-success">{{ success }}</span>
          </div>
        </form>
        <v-btn v-else @click="loadSettings">Retry loading settings</v-btn>
      </template>
    </div>
  </main>
</template>
