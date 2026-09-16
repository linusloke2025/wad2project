import { createApp } from 'vue'
import { createPinia } from 'pinia'

// Bootstrap's CSS is imported from node_modules rather than a CDN so the app has no runtime
// dependency on a third party being reachable — which matters on a venue's flaky wifi.
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.min.js'

import App from './App.vue'
import router from './router/index.js'
import './assets/app.css'

createApp(App).use(createPinia()).use(router).mount('#app')
