<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { api } from './api.js'
import { useRoute } from 'vue-router'

const timeZone = ref(null)
const route = useRoute()
const configLoading = ref(true)
const configError = ref('')
let configController = null

async function loadConfig() {
  configController?.abort()
  const controller = new AbortController()
  configController = controller
  configLoading.value = true
  configError.value = ''
  try {
    const config = await api('/api/config', controller.signal)
    if (controller.signal.aborted) return
    if (typeof config.time_zone !== 'string' || !config.time_zone.trim()) {
      throw new Error('The collector did not supply a library timezone.')
    }
    // Reject unusable configuration before mounting any timezone-dependent pages.
    new Intl.DateTimeFormat('en', { timeZone: config.time_zone })
    timeZone.value = config.time_zone
  } catch (error) {
    if (!controller.signal.aborted) configError.value = error.message
  } finally {
    if (!controller.signal.aborted) configLoading.value = false
  }
}

onMounted(loadConfig)
onBeforeUnmount(() => configController?.abort())
watch(() => route.path, (path, previous) => {
  if (path === '/' && previous === '/settings') loadConfig()
})

function settingsSaved(settings) {
  timeZone.value = settings.time_zone
}
</script>

<template>
  <v-app>
    <div class="app-shell">
      <nav class="app-nav" aria-label="Main navigation">
        <RouterLink to="/">Library</RouterLink>
        <RouterLink to="/sql">SQL query</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <div class="route-surface">
        <div v-if="configLoading" class="config-state" role="status" aria-busy="true">
          <h1>Connecting to your library</h1>
          <p class="muted">Loading the collector’s timezone configuration…</p>
          <v-progress-linear indeterminate color="primary" aria-label="Loading library configuration" />
        </div>
        <div v-else-if="configError" class="config-state" role="alert">
          <h1>Could not load library configuration</h1>
          <p class="error">{{ configError }}</p>
          <p class="muted">Check that the collector server is running, then retry.</p>
          <v-btn @click="loadConfig">Retry configuration</v-btn>
        </div>
        <RouterView v-else v-slot="{ Component, route }">
          <component :is="Component" :key="route.path === '/' ? `library:${timeZone}` : route.path"
            v-bind="route.path === '/' ? { timeZone } : {}" @saved="settingsSaved" />
        </RouterView>
      </div>
    </div>
  </v-app>
</template>
