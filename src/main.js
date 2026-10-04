import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import { VApp, VBtn, VTextField, VProgressLinear, VAutocomplete, VSelect } from 'vuetify/components'
import { Ripple } from 'vuetify/directives'
import 'vuetify/styles'
import App from './App.vue'
import router from './router.js'
import './style.css'

const vuetify = createVuetify({
  components: { VApp, VBtn, VTextField, VProgressLinear, VAutocomplete, VSelect },
  directives: { Ripple },
  theme: {
    defaultTheme: 'libraryDark',
    themes: {
      libraryDark: {
        dark: true,
        colors: { background: '#171819', surface: '#202123', primary: '#a8b9df', error: '#f3a6a6' },
      },
    },
  },
  defaults: { VBtn: { rounded: 'sm', variant: 'text' } },
})

createApp(App).use(vuetify).use(router).mount('#app')
