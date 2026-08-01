# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CivicPulse: residents report civic issues (photo + comment + GPS location), an LLM classifies and routes the report to a department, checks for duplicates, and staff track/resolve it on a Kanban board. Full product scope is in `B4-Group11-Capstone-1Pager.pdf` and `CivicPulse_PRD_LATEST.docx` at the repo root — this codebase implements **Phase 1 only** (the core report -> AI triage -> dedup -> Kanban -> closure/rating loop). SLA auto-escalation, SMS/Telegram delivery, analytics dashboards, the RAG chatbot, and voice/multilingual input are PRD-scoped but not yet built.

## Commands

```sh
npm run dev       # Vite dev server
npm run build     # tsc -b (type-check, no emit) && vite build
npm run preview   # preview a production build
npm run lint      # oxlint

supabase db push               # apply supabase/migrations/*.sql to the linked project
supabase functions deploy analyze-issue
supabase functions deploy manage-users
supabase secrets set OPENAI_API_KEY=sk-proj-...
```

Edge functions deploy with `--use-api` to build server-side when Docker isn't running locally.

There is no test suite yet. `npm run build` is the fastest way to catch type errors across the whole `src/` tree since `tsc -b` runs before `vite build`.

## Architecture

**Two runtimes, one Postgres database.** The React SPA (`src/`) talks to Supabase directly using the anon key for everything *except* AI classification — image analysis and the OpenAI API key live only in the Supabase Edge Function (`supabase/functions/analyze-issue`, Deno), never in client code. This is the one place secrets are handled server-side; everything else relies on Postgres RLS to authorize.

**Report submission is a two-phase commit, not a single insert.** `src/pages/ReportIssue.tsx` first computes a perceptual hash of the photo client-side (`src/lib/imageHash.ts`, dHash algorithm) and calls the `analyze-issue` edge function with the image + comment + area. That function calls OpenAI (strict JSON Schema for structured output) *and* queries Postgres directly (service-role key, bypassing RLS) for open issues in the same area/type whose stored `image_signature` is within a Hamming-distance threshold. Only if it comes back non-duplicate does the frontend upload the photo to Storage and insert the `issues` row itself. This ordering matters: dedup must happen *before* the ticket exists, or every report creates a ticket.

**Status transitions always pair a table update with an audit row.** Every place that changes `issues.status` (report submission, Kanban drag-and-drop in `Board.tsx`, resolution in `IssueDetailModal.tsx`, `MyWork.tsx`, the `rate_issue` RPC) also inserts into `issue_status_history`. Only auto-assignment has a trigger writing its own audit row; everywhere else it's a manual insert, so if you add a status-changing code path you must write the history row yourself or the audit trail and the `TrackIssue` timeline silently go stale.

**RLS, not application code, is the access-control boundary.** Anonymous residents can insert/select `issues` and `issue_status_history` (reporting and tracking need no login), but can only mutate an issue via the `rate_issue()` SECURITY DEFINER RPC (`supabase/migrations/0001_init.sql`), which also enforces the reopen-limit logic. Staff `UPDATE issues` rights are decided in the `issues_update_staff` policy itself, not in `Board.tsx`: `super_admin` anywhere, `dept_admin` within their own department, `field_engineer` only on tickets assigned to them. `RequireRole` in the router is a usability layer that shows a friendly gate — it is *not* the boundary. When adding a staff-only mutation, add/extend a policy rather than gating in the UI.

**Three staff roles, one of which is provisioned outside the app.** `profiles.role` is `super_admin` | `dept_admin` | `field_engineer` (`0002_roles_roster_autoassign.sql`). A super admin has no `department_id` and every dept-admin capability everywhere; a dept admin and a field engineer must have one — enforced by the `profiles_department_required` check constraint. A partial unique index caps each department at one `dept_admin`. The **first super admin cannot be created through the UI** (there is no one to authorise it), so it is bootstrapped by hand: create the auth user in the dashboard, then insert the `profiles` row via the SQL editor.

**User creation runs in an edge function because it needs the service-role key.** `supabase/functions/manage-users` re-derives the caller's role from their JWT against the `profiles` table and ignores any role claim in the request body. Super admins may create dept admins and field engineers; dept admins may create field engineers in their own department only. If the `profiles` insert fails after `auth.admin.createUser` succeeds, the function deletes the orphaned auth user — otherwise that email is permanently taken by an account that can log in but has no role.

**Assignment happens in Postgres, not in the client.** A `BEFORE INSERT` trigger on `issues` calls `pick_engineer_for(department_id)`, which returns the on-shift `field_engineer` in that department with the fewest tickets in `created`/`assigned`/`in_progress`. Shifts are weekly-recurring rows in `roster_shifts` (`weekday` 0 = Monday, times are wall-clock IST — the lookup converts `now()` to `Asia/Kolkata` before comparing). Assignment is set on `NEW` rather than by a follow-up `UPDATE`, so it lands in the same row write. Because this is a trigger, *every* insert path gets assignment — don't reimplement it in the frontend.

**Off-hours reports are queued, not dropped.** If nobody is rostered when a report lands, `assigned_to` stays NULL and an audit row says so. `sweep_unassigned_issues()` drains the queue (high priority first, then oldest) and is scheduled via pg_cron every 15 minutes. That scheduling is wrapped in an exception-swallowing `DO` block because pg_cron isn't guaranteed to be installable — if it didn't take, call the function from an external scheduler. It is idempotent and safe to run repeatedly.

**Notifications are logged, not sent.** `notifications` rows are inserted next to every resident-facing status change (creation, resolution) but there is no email/SMS/Telegram provider wired up — this is intentional for Phase 1, not a bug. If wiring a real provider, the natural place is a DB trigger or another edge function reacting to inserts on `notifications`, not inline in the frontend.

**Kanban drag-to-resolved is intercepted.** `Board.tsx`'s `handleDragEnd` special-cases a drop onto the `resolved` column: it does not persist the status change directly (unlike every other column) because resolution requires a proof photo + comment per the PRD. Instead it opens `IssueDetailModal`, which does the actual update once the proof is submitted.

**Geolocation and image similarity have no external API dependency.** Reverse geocoding (`src/lib/geocode.ts`) uses OpenStreetMap Nominatim (free, keyless); the dedup image hash is computed in-browser via Canvas, not a vision embedding service. Both were chosen to avoid requiring another credential beyond Supabase + OpenAI — keep that constraint in mind if replacing either.

## Model note

The edge function calls OpenAI `gpt-4o` (pinned in the `MODEL` constant). If you change models, keep the Structured Outputs path (`response_format: {type: "json_schema", json_schema: {strict: true, ...}}`) — it's what guarantees parseable output; don't switch to prompting for JSON in prose. Strict mode requires `additionalProperties: false` and every property listed in `required`, so a field can't be made optional without dropping strict.
