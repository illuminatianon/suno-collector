import { createRouter, createWebHistory } from 'vue-router'
import LibraryPage from './LibraryPage.vue'
import SqlQueryPage from './SqlQueryPage.vue'
import SettingsPage from './SettingsPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: LibraryPage, meta: { title: 'Suno library' } },
    { path: '/sql', component: SqlQueryPage, meta: { title: 'SQL query · Suno library' } },
    { path: '/settings', component: SettingsPage, meta: { title: 'Settings · Suno library' } },
  ],
})

router.afterEach(to => { document.title = to.meta.title || 'Suno library' })

export default router
