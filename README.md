# CivicPulse

AI-powered civic issue reporting and tracking. Residents submit a photo + comment + location; a vision model classifies the issue, routes it to a department, and checks for duplicates before a ticket is created. Staff track and resolve tickets on a Kanban board.

This is **Phase 1** of the CivicPulse capstone project (see `B4-Group11-Capstone-1Pager.pdf` and `CivicPulse_PRD_LATEST.docx`): the core report -> AI triage -> dedup -> Kanban -> closure/rating loop. SLA auto-escalation, SMS/Telegram delivery, analytics dashboards, the RAG chatbot, and voice/multilingual input are deferred to later phases.

## Stack

- **Frontend:** React + Vite + TypeScript, Tailwind CSS, React Router
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime) + a Supabase Edge Function for AI classification
- **AI:** OpenAI (`gpt-4o`) via the Edge Function -- joint image+text classification with Structured Outputs, department routing, priority scoring
- **Dedup:** client-computed perceptual image hash (dHash) + area/issue-type match, compared server-side in the Edge Function
- **Notifications:** logged to a `notifications` table only (stub) -- no real email/SMS/Telegram provider wired up yet

## Prerequisites

- Node.js 18+
- A Supabase project ([supabase.com](https://supabase.com))
- An OpenAI API key ([platform.openai.com](https://platform.openai.com/api-keys))
- The [Supabase CLI](https://supabase.com/docs/guides/cli) to deploy the Edge Function and run migrations

## Setup

1. **Install dependencies**

   ```sh
   npm install
   ```

2. **Configure the frontend**

   ```sh
   cp .env.example .env
   ```

   Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from your Supabase project's API settings.

3. **Apply the database schema**

   ```sh
   supabase link --project-ref YOUR-PROJECT-REF
   supabase db push
   ```

   This creates the `departments`, `profiles`, `issues`, `issue_status_history`, and `notifications` tables, RLS policies, the `rate_issue` RPC, and the public `issue-photos` storage bucket.

4. **Deploy the Edge Function**

   ```sh
   supabase secrets set OPENAI_API_KEY=sk-proj-your-key-here
   supabase functions deploy analyze-issue
   ```

5. **Create a staff account**

   Staff (admin / department_user) accounts aren't self-service. Create a user in Supabase Dashboard -> Authentication -> Users, then add a matching row to `profiles`:

   ```sql
   insert into profiles (id, full_name, role, department_id)
   values (
     '<auth-user-uuid>',
     'Jane Doe',
     'admin', -- or 'department_user'
     null     -- or a departments.id for a department_user
   );
   ```

6. **Run the app**

   ```sh
   npm run dev
   ```

## Project structure

```
src/
  pages/         ReportIssue, TrackIssue, Login, Board (Kanban)
  components/    Navbar, IssueCard, KanbanColumn, IssueDetailModal, RatingWidget, StatusBadge
  hooks/useAuth  Supabase session + staff profile
  lib/           supabaseClient, types, imageHash (dHash), geocode (Nominatim reverse geocoding)
supabase/
  migrations/    SQL schema, RLS, RPCs, storage bucket
  functions/
    analyze-issue/  Edge Function: OpenAI classification + dedup check
```

## How a report flows

1. Resident submits a photo, comment, optional landmark/contact, and captures GPS location (reverse-geocoded client-side via OpenStreetMap Nominatim -- no API key needed).
2. The frontend computes a perceptual hash of the photo and calls the `analyze-issue` Edge Function with the image + text.
3. The Edge Function calls OpenAI to classify the issue type, department, and priority, then checks open issues in the same area for a hash match within a similarity threshold.
4. If a duplicate is found, the resident is pointed to the existing ticket instead of creating a new one.
5. Otherwise a ticket (`issues` row) is created with status `assigned`, and an audit trail (`issue_status_history`) is logged.
6. Staff work the ticket on the Kanban board (drag between columns, or use the detail modal to submit resolution proof).
7. The resident tracks the ticket by number, sees the resolution, and rates it -- a poor rating automatically reopens the ticket via the `rate_issue` RPC.
