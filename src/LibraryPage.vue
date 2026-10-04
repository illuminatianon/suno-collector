<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import MetadataValue from './MetadataValue.vue'
import LibraryTimeline from './LibraryTimeline.vue'
import { api } from './api.js'

const props = defineProps({
  timeZone: { type: String, required: true },
})

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  timeZone: props.timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
})
const yearFormatter = new Intl.DateTimeFormat('en', { timeZone: props.timeZone, year: 'numeric' })
const currentYear = () => Number(yearFormatter.format(new Date()))

const songs = ref([])
const total = ref(0)
const inventory = ref(null)
const query = ref('')
const loading = ref(false)
const listError = ref('')
const selectedId = ref(null)
const detail = ref(null)
const detailLoading = ref(false)
const detailError = ref('')
const mobileDetail = ref(false)
const detailHeading = ref(null)
const copyFeedback = ref('')
let copySequence = 0
async function copySongId() {
  const id = selectedId.value
  if (!id) return
  const sequence = ++copySequence
  try {
    await navigator.clipboard.writeText(id)
    if (sequence === copySequence && selectedId.value === id) copyFeedback.value = 'Song UUID copied.'
  } catch {
    if (sequence === copySequence && selectedId.value === id) copyFeedback.value = 'Could not copy song UUID. Select the UUID text to copy it.'
  }
}
watch(selectedId, () => { ++copySequence; copyFeedback.value = '' })
const listHeading = ref(null)
const view = ref('songs')
const selectedDay = ref(null)
const timeline = ref({ days: [], first_date: null, last_date: null, total: 0 })
const timelineYear = ref(currentYear())
const timelineLoading = ref(false)
const timelineError = ref('')
let timelineController = null
let timelineSequence = 0
let timelineInitialized = false
let listController = null
let detailController = null
let searchTimer = null
let listSequence = 0
let detailSequence = 0


async function loadSongs(append = false) {
  clearTimeout(searchTimer)
  const sequence = ++listSequence
  listController?.abort()
  listController = new AbortController()
  loading.value = true
  listError.value = ''
  const offset = append ? songs.value.length : 0
  try {
    const params = new URLSearchParams({ limit: '100', offset: String(offset), q: query.value })
    if (selectedDay.value) {
      const next = new Date(`${selectedDay.value}T00:00:00Z`)
      // Advance a calendar label, not a local instant: DST must not change the next date.
      next.setUTCDate(next.getUTCDate() + 1)
      params.set('from', selectedDay.value)
      params.set('to', next.toISOString().slice(0, 10))
    }
    const data = await api(`/api/library?${params}`, listController.signal)
    if (sequence !== listSequence) return
    songs.value = append ? [...songs.value, ...data.songs.filter(song => !songs.value.some(existing => existing.id === song.id))] : data.songs
    total.value = data.total
    inventory.value = data.total_songs
    if (!append && !songs.value.some(song => song.id === selectedId.value)) {
      if (songs.value.length) selectSong(songs.value[0].id, false)
      else clearSelection()
    } else if (!append && selectedId.value) {
      selectSong(selectedId.value, false)
    }
  } catch (error) {
    if (sequence === listSequence && error.name !== 'AbortError') listError.value = error.message
  } finally {
    if (sequence === listSequence) loading.value = false
  }
}

function clearSelection() {
  ++detailSequence
  detailController?.abort()
  selectedId.value = null
  detail.value = null
  detailLoading.value = false
  detailError.value = ''
  mobileDetail.value = false
}

async function selectSong(id, navigate = true) {
  const sequence = ++detailSequence
  detailController?.abort()
  detailController = new AbortController()
  const controller = detailController
  selectedId.value = id
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  if (navigate) {
    mobileDetail.value = true
    await nextTick()
    detailHeading.value?.focus()
  }
  try {
    if (sequence !== detailSequence) return
    const data = await api(`/api/library/${encodeURIComponent(id)}`, controller.signal)
    if (sequence === detailSequence) detail.value = data
  } catch (error) {
    if (sequence === detailSequence && error.name !== 'AbortError') detailError.value = error.message
  } finally {
    if (sequence === detailSequence) detailLoading.value = false
  }
}

async function backToList() {
  mobileDetail.value = false
  await nextTick()
  listHeading.value?.focus()
}

async function loadTimeline() {
  const sequence = ++timelineSequence
  timelineController?.abort()
  timelineController = new AbortController()
  timelineLoading.value = true
  timelineError.value = ''
  try {
    const data = await api('/api/library/timeline', timelineController.signal)
    if (sequence !== timelineSequence) return
    timeline.value = data
    const current = currentYear()
    const first = Number(data.first_date?.slice(0, 4)) || current
    const last = Number(data.last_date?.slice(0, 4)) || current
    timelineYear.value = timelineInitialized ? Math.max(first, Math.min(last, timelineYear.value)) : last
    timelineInitialized = true
    if (selectedDay.value && Number(selectedDay.value.slice(0, 4)) !== timelineYear.value) selectedDay.value = null
  } catch (error) {
    if (sequence === timelineSequence && error.name !== 'AbortError') timelineError.value = error.message
  } finally {
    if (sequence === timelineSequence) timelineLoading.value = false
  }
}

function refreshLibrary() {
  loadSongs()
  if (view.value === 'timeline') loadTimeline()
}

function changeYear(year) {
  selectedDay.value = null
  timelineYear.value = year
}

watch(selectedDay, () => {
  ++listSequence
  listController?.abort()
  clearTimeout(searchTimer)
  songs.value = []
  clearSelection()
  loadSongs()
}, { flush: 'sync' })

watch(view, value => {
  selectedDay.value = null
  if (value === 'timeline') loadTimeline()
  else {
    ++timelineSequence
    timelineController?.abort()
    timelineLoading.value = false
  }
}, { flush: 'sync' })

watch(query, () => {
  ++listSequence
  listController?.abort()
  loading.value = true
  listError.value = ''
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadSongs(), 250)
})
onMounted(() => loadSongs())
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  listController?.abort()
  detailController?.abort()
  timelineController?.abort()
})

function date(value) {
  if (!value) return 'Date unknown'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? String(value) : timestampFormatter.format(parsed)
}
function duration(value) {
  if (value === null || value === undefined || value === '') return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : String(value)
}

function flatten(value, parts = [], result = []) {
  if (value && typeof value === 'object' && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) flatten(child, [...parts, key], result)
  } else result.push({ path: parts.join('.'), key: parts.at(-1) || 'clip', value })
  return result
}
const fields = computed(() => detail.value ? flatten(detail.value.clip) : [])
const lyrics = computed(() => fields.value.filter(field => /^(lyrics|full_lyrics|display_lyrics|prompt)$/i.test(field.key) && typeof field.value === 'string'))
const clip = computed(() => detail.value?.clip ?? {})
const metadata = computed(() => clip.value.metadata ?? {})
const known = value => value !== null && value !== undefined && value !== ''
const flags = computed(() => [
  metadata.value.is_remix === true || metadata.value.is_remix === 1 || clip.value.is_remix === true || clip.value.is_remix === 1 ? 'Remix' : null,
  clip.value.is_public === true || clip.value.is_public === 1 ? 'Public' : clip.value.is_public === false || clip.value.is_public === 0 ? 'Private' : null,
  clip.value.explicit === true || clip.value.explicit === 1 || clip.value.is_explicit === true || clip.value.is_explicit === 1 ? 'Explicit' : null,
].filter(Boolean))
const positiveTags = computed(() => metadata.value.tags ?? clip.value.tags)
const negativeTags = computed(() => metadata.value.negative_tags)
const persona = computed(() => detail.value?.persona ?? clip.value.persona ?? null)
const personaId = computed(() => persona.value?.id ?? clip.value.persona_id ?? metadata.value.persona_id)
const personaFields = computed(() => {
  const value = persona.value
  if (!value) return []
  return [
    ['Name', value.name],
    ['Type', value.persona_type],
    ['Handle', value.user_handle],
    ['UUID', value.id],
    ['Root clip ID', value.root_clip_id],
    ['Owned', value.is_owned === undefined || value.is_owned === null ? null : value.is_owned === true || value.is_owned === 1 ? 'Yes' : 'No'],
    ['Public', value.is_public === undefined || value.is_public === null ? null : value.is_public === true || value.is_public === 1 ? 'Yes' : 'No'],
    ['Image ID', value.image_s3_id],
  ].filter(([, entry]) => known(entry))
})
const groups = computed(() => {
  const definitions = [
    ['Styles', /tag|style|negative|genre/i],
    ['Generation & sliders', /model|version|duration|seed|slider|weight|scale|weird|audio_influence|creativ|control|guidance|generation|task|status|type|instrumental|bpm|tempo|key_signature/i],
    ['Ownership, visibility & reactions', /user|owner|creator|author|display_name|handle|public|publish|visible|visibility|like|play_count|upvote|downvote|reaction|flag|explicit|trashed|deleted|hidden|is_|can_/i],
    ['Sources & relationships', /source|parent|ancestor|remix|extend|cover|concat|crop|original|reference|persona|song_id|clip_id|history|child/i],
    ['Dates', /_at$|date|timestamp/i],
    ['Links', /url|uri|link/i],
  ]
  const buckets = definitions.map(([title]) => ({ title, fields: [] }))
  const remaining = { title: 'Additional metadata', fields: [] }
  const lyricPaths = new Set(lyrics.value.map(field => field.path))
  for (const field of fields.value) {
    if (lyricPaths.has(field.path)) continue
    // Links take precedence so even source/audio/image URLs are findable without loading them.
    const index = /url|uri|link/i.test(field.key) ? 5 : definitions.findIndex(([, pattern]) => pattern.test(field.path))
    if (index < 0) remaining.fields.push(field)
    else buckets[index].fields.push(field)
  }
  return [...buckets, remaining].filter(group => group.fields.length)
})
const raw = computed(() => detail.value ? JSON.stringify(detail.value, null, 2) : '')
const title = computed(() => detail.value?.clip?.title || songs.value.find(song => song.id === selectedId.value)?.title || 'Untitled song')
</script>

<template>
    <div class="library-shell" :class="{ 'show-detail': mobileDetail, 'timeline-view': view === 'timeline' }">
      <LibraryTimeline v-if="view === 'timeline'" :time-zone="timeZone" :timeline="timeline" :year="timelineYear" :selected-day="selectedDay" :loading="timelineLoading" :error="timelineError" @select="selectedDay = $event" @clear="selectedDay = null" @year="changeYear" @retry="loadTimeline" />
      <aside class="song-panel" aria-label="Song library">
        <header class="library-header">
          <div class="heading-line">
            <h1 ref="listHeading" tabindex="-1">Suno Library</h1>
            <v-btn :disabled="loading || timelineLoading" @click="refreshLibrary">Refresh</v-btn>
          </div>
          <p class="muted inventory" aria-live="polite">{{ inventory === null ? 'Connecting to your collector…' : `${inventory.toLocaleString()} songs captured` }}</p>
          <div class="view-switch" role="group" aria-label="Library view">
            <v-btn size="small" :aria-pressed="view === 'songs'" :class="{ 'active-view': view === 'songs' }" @click="view = 'songs'">Songs</v-btn>
            <v-btn size="small" :aria-pressed="view === 'timeline'" :class="{ 'active-view': view === 'timeline' }" @click="view = 'timeline'">Timeline</v-btn>
          </div>
          <p v-if="selectedDay" class="date-filter">Date: {{ selectedDay }} {{ timeZone }} <v-btn size="small" @click="selectedDay = null">Clear</v-btn></p>
          <v-text-field v-model="query" label="Search song titles" variant="outlined" density="compact" hide-details />
          <p v-if="query" class="search-count muted" aria-live="polite">{{ loading ? 'Searching…' : `${total.toLocaleString()} matching songs` }}</p>
          <v-btn v-if="query" size="small" @click="query = ''">Clear search</v-btn>
        </header>
        <div class="song-scroll" :aria-busy="loading">
          <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading songs" />
          <div v-if="listError" class="state error" role="alert">
            <p>{{ listError }}</p>
            <v-btn @click="loadSongs()">Retry library</v-btn>
          </div>
          <p v-if="!loading && !listError && !songs.length" class="state muted">{{ selectedDay ? (query ? `No songs on this ${timeZone} day match your title search.` : `No songs captured on this ${timeZone} day. Select another day or clear the date filter.`) : query ? 'No songs match this title. Try another search.' : 'No songs captured yet. Browse Suno with the collector enabled, then refresh.' }}</p>
          <ul class="song-list">
            <li v-for="song in songs" :key="song.id">
              <button class="song-row" :class="{ selected: song.id === selectedId }" :aria-current="song.id === selectedId ? 'true' : undefined" @click="selectSong(song.id)">
                <span class="song-title">{{ song.title || 'Untitled song' }}</span>
                <span class="song-date">{{ date(song.created_at) }}</span>
                <span class="song-meta">{{ [song.model_name, duration(song.duration), song.status].filter(Boolean).join(' · ') || 'Generation details unavailable' }}</span>
              </button>
            </li>
          </ul>
          <div v-if="songs.length" class="list-end">
            <p class="muted">{{ songs.length.toLocaleString() }} of {{ total.toLocaleString() }}{{ query ? ' matches' : ' songs' }}</p>
            <v-btn v-if="songs.length < total" variant="outlined" :disabled="loading" @click="loadSongs(true)">Load more songs</v-btn>
          </div>
        </div>
      </aside>

      <main class="detail-panel" aria-label="Selected song" :aria-busy="detailLoading">
        <header class="detail-header">
          <v-btn class="back-button" @click="backToList">Back to songs</v-btn>
          <div class="detail-title-line">
            <h2 ref="detailHeading" tabindex="-1">{{ selectedId ? title : 'Song details' }}</h2>
            <button v-if="selectedId" type="button" class="copy-song-id" aria-label="Copy song UUID" title="Copy song UUID" @click="copySongId">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
            </button>
          </div>
          <div class="song-identifier">
            <p v-if="selectedId" class="song-id muted">{{ selectedId }}</p>
            <span class="copy-feedback" :class="{ error: copyFeedback.startsWith('Could not') }" role="status" aria-live="polite">{{ copyFeedback }}</span>
          </div>
          <template v-if="detail">
            <p class="detail-created muted">Created {{ date(clip.created_at) }}</p>
            <div v-if="flags.length" class="detail-badges" aria-label="Song attributes"><span v-for="flag in flags" :key="flag" class="detail-badge">{{ flag }}</span></div>
          </template>
        </header>
        <div class="detail-scroll">
          <v-progress-linear v-if="detailLoading" indeterminate color="primary" aria-label="Loading song details" />
          <p v-if="detailLoading" class="state muted" role="status">Loading complete song metadata…</p>
          <div v-else-if="detailError" class="state error" role="alert">
            <p>{{ detailError }}</p>
            <v-btn @click="selectSong(selectedId, false)">Retry song</v-btn>
          </div>
          <p v-else-if="!detail" class="state muted">Select a song to read its lyrics and captured metadata.</p>
          <template v-else>
            <div class="detail-columns">
              <section class="detail-section lyric-section" aria-labelledby="lyrics-heading">
                <h3 id="lyrics-heading">Lyrics & prompt</h3>
                <template v-if="lyrics.length">
                  <div v-for="field in lyrics" :key="field.path" class="lyric-block">
                    <h4>{{ field.path }}</h4>
                    <p class="lyrics">{{ field.value || 'No text captured in this field.' }}</p>
                  </div>
                </template>
                <p v-else class="muted">No lyrics or prompt were captured for this song.</p>
              </section>
              <aside class="detail-sidebar" aria-label="Song tags and persona">
                <section class="detail-section">
                  <h3>Tags</h3>
                  <h4>Positive tags</h4>
                  <p class="tag-text" :class="{ muted: !known(positiveTags) }">{{ known(positiveTags) ? positiveTags : 'No positive tags captured.' }}</p>
                  <h4>Negative tags</h4>
                  <p class="tag-text" :class="{ muted: !known(negativeTags) }">{{ known(negativeTags) ? negativeTags : 'No negative tags captured.' }}</p>
                </section>
                <section class="detail-section">
                  <h3>Persona</h3>
                  <dl v-if="personaFields.length" class="persona-grid">
                    <template v-for="[label, value] in personaFields" :key="label">
                      <dt>{{ label }}</dt><dd>{{ value }}</dd>
                    </template>
                  </dl>
                  <template v-else-if="known(personaId)">
                    <p class="persona-identifier">{{ personaId }}</p>
                    <p class="muted">No persona details captured.</p>
                  </template>
                  <p v-else class="muted">No persona captured for this song.</p>
                </section>
              </aside>
            </div>
            <section class="detail-section more-metadata">
              <details>
                <summary>More metadata</summary>
                <div v-for="group in groups" :key="group.title" class="metadata-group">
                  <h3>{{ group.title }}</h3>
                  <dl class="metadata-grid">
                    <template v-for="field in group.fields" :key="field.path">
                      <dt>{{ field.path }}</dt>
                      <dd><MetadataValue :value="field.value" /></dd>
                    </template>
                  </dl>
                </div>
                <div class="metadata-group">
                  <h3>Capture history</h3>
                  <dl class="metadata-grid">
                    <dt>First captured</dt><dd>{{ date(detail.first_captured_at) }}</dd>
                    <dt>Last updated</dt><dd>{{ date(detail.updated_at) }}</dd>
                  </dl>
                </div>
              </details>
            </section>
            <section class="detail-section raw-section">
              <details>
                <summary>Full captured JSON</summary>
                <p class="muted">The complete original clip and capture timestamps, including every nested field.</p>
                <pre>{{ raw }}</pre>
              </details>
            </section>
          </template>
        </div>
      </main>
    </div>
</template>
