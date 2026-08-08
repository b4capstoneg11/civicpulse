import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import { AuthProvider } from './components/AuthProvider'
import { ThemeProvider } from './components/ThemeProvider'
import { Navbar } from './components/Navbar'
import { AssistantDrawer } from './components/AssistantDrawer'
import { RequireRole } from './components/RequireRole'
import { Spinner } from './components/ui'
import { ReportIssue } from './pages/ReportIssue'

// `/` is the landing route for residents, so it ships in the main bundle.
// Everything behind a login splits out — the board in particular drags in the
// drag-and-drop library, which no resident ever loads.
const TrackIssue = lazy(() => import('./pages/TrackIssue').then((m) => ({ default: m.TrackIssue })))
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })))
const Board = lazy(() => import('./pages/Board').then((m) => ({ default: m.Board })))
const MyWork = lazy(() => import('./pages/MyWork').then((m) => ({ default: m.MyWork })))
const AdminUsers = lazy(() => import('./pages/AdminUsers').then((m) => ({ default: m.AdminUsers })))
const AdminRoster = lazy(() => import('./pages/AdminRoster').then((m) => ({ default: m.AdminRoster })))
// Analytics pulls in the PDF library, so it stays in its own chunk — nobody
// downloads jsPDF unless they open this page.
const Analytics = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.Analytics })))

function RouteFallback() {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-24 text-sm text-muted" role="status">
      <Spinner />
      Loading…
    </div>
  )
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="mb-2 text-2xl font-semibold text-ink text-balance">Page Not Found</h1>
      <p className="mb-6 text-ink-soft text-pretty">
        That link doesn’t point anywhere. Try reporting an issue or tracking an existing ticket.
      </p>
      <Link
        to="/"
        className="inline-flex rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        Report an Issue
      </Link>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      {/* Theme sits outside auth: a resident who never signs in still gets it. */}
      <ThemeProvider>
      <AuthProvider>
        <div className="min-h-screen bg-canvas text-ink">
          <a
            href="#main"
            className="sr-only rounded-md bg-accent-dim px-4 py-2 text-sm font-medium text-canvas focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
          >
            Skip to Main Content
          </a>
          <Navbar />
          {/* Mounted once, outside the routes, so the conversation survives
              navigation and closing the drawer. Renders nothing for residents. */}
          <AssistantDrawer />
          <main id="main">
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<ReportIssue />} />
                <Route path="/track" element={<TrackIssue />} />
                <Route path="/login" element={<Login />} />

                <Route
                  path="/board"
                  element={
                    <RequireRole allow={['super_admin', 'dept_admin']}>
                      <Board />
                    </RequireRole>
                  }
                />
                <Route
                  path="/roster"
                  element={
                    <RequireRole allow={['super_admin', 'dept_admin']}>
                      <AdminRoster />
                    </RequireRole>
                  }
                />
                <Route
                  path="/users"
                  element={
                    <RequireRole allow={['super_admin', 'dept_admin']}>
                      <AdminUsers />
                    </RequireRole>
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    <RequireRole allow={['super_admin', 'dept_admin']}>
                      <Analytics />
                    </RequireRole>
                  }
                />
                <Route
                  path="/my-work"
                  element={
                    <RequireRole allow={['field_engineer']}>
                      <MyWork />
                    </RequireRole>
                  }
                />

                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

export default App
