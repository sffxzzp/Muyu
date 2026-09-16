import { ref } from 'vue'

export type View = 'new' | 'tasks' | 'merge' | 'detail'
export const view = ref<View>('new'),
  selectedId = ref(''),
  sidebarOpen = ref(false)
function readRoute() {
  const hash = location.hash.replace(/^#\/?/, '')
  if (hash.startsWith('task/')) {
    selectedId.value = hash.slice(5)
    view.value = 'detail'
  } else view.value = hash === 'tasks' ? 'tasks' : hash === 'merge' ? 'merge' : 'new'
  sidebarOpen.value = false
}
export function watchNavigation() {
  readRoute()
  window.addEventListener('hashchange', readRoute)
  return () => window.removeEventListener('hashchange', readRoute)
}
export function navigate(next: View, id = '') {
  location.hash = next === 'detail' ? `/task/${id}` : `/${next}`
  readRoute()
  window.scrollTo({ top: 0 })
}
