import { lazy, Suspense } from 'react'
import { useAuth } from '../hooks/useAuth'

// Every toast in the app is raised by a staff action (the ticket modal and the
// Team page). Mounting the Toaster only behind a session keeps sonner out of
// the bundle residents download, and the lazy chunk lands on login — long
// before any page that can raise a toast is reachable, so nothing is dropped.
const Toaster = lazy(() => import('@/components/ui/sonner').then((m) => ({ default: m.Toaster })))

export function StaffToaster() {
  const { session } = useAuth()
  if (!session) return null
  return (
    <Suspense fallback={null}>
      <Toaster position="bottom-center" closeButton />
    </Suspense>
  )
}
