<script setup>
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <v-app>
    <div class="app-shell">
      <nav class="app-nav" aria-label="Main navigation">
        <RouterLink to="/">Library</RouterLink>
        <RouterLink to="/sql">SQL query</RouterLink>
      </nav>
      <div class="route-surface">
        <RouterView />
      </div>
    </div>
  </v-app>
</template>
