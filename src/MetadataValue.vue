<script setup>
import { computed } from 'vue'
const props = defineProps({ value: { default: null } })
const text = computed(() => props.value === null ? 'null' : typeof props.value === 'object' ? JSON.stringify(props.value, null, 2) : String(props.value))
const link = computed(() => {
  if (typeof props.value !== 'string') return null
  try {
    const url = new URL(props.value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
})
</script>

<template>
  <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer">{{ text }}</a>
  <span v-else class="metadata-value">{{ text === '' ? '(empty string)' : text }}</span>
</template>
