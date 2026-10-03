<script setup>
import { computed } from 'vue'

const props = defineProps({
  timeline: { type: Object, required: true },
  year: { type: Number, required: true },
  selectedDay: { type: String, default: null },
  loading: Boolean,
  error: { type: String, default: '' },
})
const emit = defineEmits(['select', 'year', 'clear', 'retry'])
const currentYear = new Date().getUTCFullYear()
const firstYear = computed(() => Number(props.timeline.first_date?.slice(0, 4)) || currentYear)
const lastYear = computed(() => Number(props.timeline.last_date?.slice(0, 4)) || currentYear)
const counts = computed(() => new Map(props.timeline.days.map(day => [day.date, day.count])))
const maximum = computed(() => Math.max(1, ...props.timeline.days.filter(day => day.date.startsWith(`${props.year}-`)).map(day => day.count)))
const calendar = computed(() => {
  const start = new Date(0)
  start.setUTCFullYear(props.year, 0, 1)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setUTCFullYear(props.year + 1)
  const offset = (start.getUTCDay() + 6) % 7
  const days = []
  const months = []
  for (let time = start.getTime(), index = 0; time < end.getTime(); time += 86400000, index++) {
    const date = new Date(time)
    const key = date.toISOString().slice(0, 10)
    const column = Math.floor((offset + index) / 7) + 1
    const row = (offset + index) % 7 + 1
    const count = counts.value.get(key) || 0
    days.push({ date: key, count, column, row, level: count ? Math.min(4, Math.ceil(count / maximum.value * 4)) : 0 })
    if (date.getUTCDate() === 1) months.push({ label: date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }), column })
  }
  return { days, months, columns: days.at(-1).column }
})
const selectedCount = computed(() => counts.value.get(props.selectedDay) || 0)
const datedTotal = computed(() => props.timeline.days.reduce((total, day) => total + day.count, 0))
function label(day) {
  return `${day.date} UTC: ${day.count.toLocaleString()} ${day.count === 1 ? 'song' : 'songs'}`
}
</script>

<template>
  <section class="timeline-panel" aria-labelledby="timeline-heading" :aria-busy="loading">
    <div class="timeline-heading-line">
      <div>
        <h2 id="timeline-heading">Capture timeline</h2>
        <p class="muted timeline-summary">Stored song creation dates · UTC calendar days</p>
      </div>
      <div class="year-controls" aria-label="Calendar year">
        <v-btn size="small" :disabled="loading || year <= firstYear" aria-label="Previous year" @click="emit('year', year - 1)">Previous</v-btn>
        <strong>{{ year }}</strong>
        <v-btn size="small" :disabled="loading || year >= lastYear" aria-label="Next year" @click="emit('year', year + 1)">Next</v-btn>
      </div>
    </div>
    <v-progress-linear v-if="loading" indeterminate color="primary" aria-label="Loading timeline" />
    <div v-if="error" class="timeline-error error" role="alert">
      <p>{{ error }}</p>
      <v-btn size="small" @click="emit('retry')">Retry timeline</v-btn>
    </div>
    <template v-else>
      <p class="timeline-summary muted" aria-live="polite">
        {{ timeline.total.toLocaleString() }} songs total · First: {{ timeline.first_date || 'No dated songs' }} · Last: {{ timeline.last_date || 'No dated songs' }}
        <span v-if="timeline.total > datedTotal"> · {{ (timeline.total - datedTotal).toLocaleString() }} without a usable date</span>
      </p>
      <p v-if="!loading && !timeline.days.length" class="timeline-summary muted">No dated songs captured yet. Days below have no captured songs.</p>
      <div class="calendar-scroll" tabindex="0" aria-label="Year calendar, scroll horizontally to see every month">
        <div class="calendar-layout" :style="{ '--weeks': calendar.columns }">
          <div class="calendar-months" aria-hidden="true">
            <span v-for="month in calendar.months" :key="month.label" :style="{ gridColumn: month.column }">{{ month.label }}</span>
          </div>
          <div class="calendar-weekdays" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>
          <div class="calendar-days">
            <button v-for="day in calendar.days" :key="day.date" type="button" class="calendar-day" :class="[`level-${day.level}`, { 'selected-day': selectedDay === day.date }]" :style="{ gridColumn: day.column, gridRow: day.row }" :title="label(day)" :aria-label="label(day)" :aria-pressed="selectedDay === day.date" :disabled="loading" @click="emit('select', day.date)" />
          </div>
        </div>
      </div>
      <div class="timeline-bottom">
        <p class="timeline-summary" aria-live="polite">{{ selectedDay ? `${selectedDay} UTC · ${selectedCount.toLocaleString()} songs captured` : 'Select a day to filter the song list.' }} <v-btn v-if="selectedDay" size="small" @click="emit('clear')">Clear date filter</v-btn></p>
        <div class="calendar-legend muted" aria-label="Color intensity indicates fewer to more songs"><span>Less</span><span v-for="level in 5" :key="level" class="calendar-swatch" :class="`level-${level - 1}`" /><span>More</span></div>
      </div>
    </template>
  </section>
</template>
