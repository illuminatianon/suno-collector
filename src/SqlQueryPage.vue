<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { api } from './api.js'
import { toCsv } from './csv.js'

const sql = ref('SELECT id, title, created_at FROM songs ORDER BY created_at DESC;')
const result = ref(null)
const loading = ref(false)
const error = ref('')
let controller = null

async function run() {
  if (loading.value) return
  controller = new AbortController()
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await api('/api/query', controller.signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sql.value }),
    })
  } catch (cause) {
    if (cause.name !== 'AbortError') error.value = cause.message
  } finally {
    loading.value = false
  }
}

function shortcut(event) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault()
    run()
  }
}

function download() {
  if (!result.value) return
  const url = URL.createObjectURL(new Blob([toCsv(result.value.columns, result.value.rows)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'suno-query.csv'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <main class="sql-page" aria-labelledby="sql-heading">
    <form class="sql-editor" @submit.prevent="run">
      <h1 id="sql-heading">SQL query</h1>
      <p id="sql-help" class="muted">Read-only queries against your archive. All returned rows are shown; add a LIMIT in your SQL only if you want one.</p>
      <label for="sql-input">Query</label>
      <textarea id="sql-input" v-model="sql" aria-describedby="sql-help sql-shortcut" spellcheck="false" autocapitalize="off" autocomplete="off" @keydown="shortcut" />
      <div class="sql-actions">
        <v-btn type="submit" variant="tonal" color="primary" :disabled="loading || !sql.trim()">{{ loading ? 'Running…' : 'Run query' }}</v-btn>
        <span id="sql-shortcut" class="muted">Ctrl+Enter to run · Cmd+Enter on Mac</span>
      </div>
      <p v-if="error" class="sql-error error" role="alert">{{ error }}</p>
    </form>
    <section class="sql-results" aria-label="Query results" :aria-busy="loading">
      <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Running SQL query" />
      <div class="sql-results-heading">
        <p role="status" aria-live="polite">{{ loading ? 'Running query…' : result ? `${result.rows.length.toLocaleString()} ${result.rows.length === 1 ? 'row' : 'rows'} returned` : 'Run a query to see results.' }}</p>
        <v-btn v-if="result" size="small" @click="download">Download CSV</v-btn>
      </div>
      <div v-if="result" class="sql-table-scroll" tabindex="0" role="region" aria-label="Scrollable query result table">
        <table class="sql-table">
          <caption class="visually-hidden">SQL query results</caption>
          <thead><tr><th v-for="(column, index) in result.columns" :key="index" scope="col">{{ column }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, rowIndex) in result.rows" :key="rowIndex">
              <td v-for="(value, index) in row" :key="index" :class="{ 'sql-null': value === null, 'sql-number': typeof value === 'number' }">{{ value === null ? 'NULL' : value }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!result.rows.length" class="sql-empty muted">The query returned no rows.</p>
      </div>
    </section>
  </main>
</template>
