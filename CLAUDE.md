# Running Well — working notes

Single-file app: everything is `index.html` (~10,700 lines), plus `sw.js` and
`manifest.json`. No build step, no framework, no npm. Deployed via GitHub Pages
from `main` — **pushing to `main` deploys to live staff immediately.**

Sole record of staff hours since 11 Aug 2026. Feeds MYOB payroll for real
wages. Clinic is in **Melbourne, Australia** (`Australia/Melbourne`, UTC+10/+11)
— the `en-AU` locale throughout is the reliable signal, not the clinic's name.

---

## ⚠ After ANY change to the Supabase schema

Adding, renaming or dropping a table or column affects four things, and only
one of them notices on its own. **Do all four in the same sitting.**

### 1. Re-capture the schema — manual, nothing checks this
Run `Runningwell-Vault/capture_schema.sql` in the Supabase SQL Editor. Replace
`Runningwell-Vault/schema/schema.sql` with the output, commit, push.

### 2. The backup checks itself — but only against step 1
`Runningwell-Vault/backup.py` parses `schema.sql` and **fails with an email** if
it declares a table that `TABLES` does not cover. So once step 1 is done, the
backup tells you if it needs updating.

New *columns* need nothing — the backup does `select=*`.
New *tables* must be added to `TABLES`.

### 3. Re-capture the access rules — also manual, also nothing checks this
Run `Runningwell-Vault/capture_policies.sql` in the Supabase SQL Editor and
replace `Runningwell-Vault/schema/policies.sql` with the output.

A new table arrives with RLS enabled and **no policy**, which does not error —
the anon key just sees an empty table and every write fails silently. `leave_log`
shipped that way on 15 Sep 2026 and read back empty to the app while holding 17
rows. Write the policies when you create the table, and capture them here.

Model new audit-style tables on `timesheet_audit` and `leave_log` (select and
insert only, so the published key cannot rewrite them), not on `entries`.

### 4. Run the journal coverage query — the only live check
In `Runningwell-Vault/journal_tables.sql`, the block headed **COVERAGE CHECK**.
Expect **zero rows**. Anything listed has no `trg_journal`, meaning deletions
from it are unrecoverable — silently. New tables also need adding to the array
in that file, then re-run it (safe to re-run; it drops and recreates).

### Why this checklist exists
`schema.sql` is a file in a repo, not something living in Supabase. The
automatic check compares two files in GitHub — **it cannot tell that Supabase
has gained a table nobody wrote down.** In that case the file and the script
agree with each other and are simply both stale, and everything looks green.

Only the journal coverage query reads the live database (`pg_class`).

*Not theoretical: `timesheet_audit` (868 rows) and `public_holidays` existed for
months with neither backup nor journal coverage before a review caught it.*

---

## Data protection currently in place

- **`data_journal`** — append-only triggers on all 15 tables capturing every row
  version. Unreachable with the published anon key (`42501` on read, `401` on
  delete). Makes any wipe recoverable. Setup: `journal_tables.sql`.
- **Daily off-site backup** — private repo `WellnessOnWellington/Runningwell-Vault`,
  12:00 UTC via GitHub Actions. Refuses to write if a table that had rows returns
  zero, or if total rows halve. Failure email verified working.
- **Local snapshot** — `backups/backup_supabase.py`, run by hand any time.

**Pushing to `.github/workflows/` needs the `workflow` token scope**, which the
current PAT lacks. Workflow edits must go through the GitHub web UI; everything
else pushes normally.

---

## Things that will bite you

- **The Supabase anon key is published** in this file and grants full read and
  delete on almost every table. All PIN checks are client-side and bypassable.
  See the Database Lockdown plan. Remediation is planned, not built.
  The mechanism is **permissive policies, not absent RLS** — this note used to
  say otherwise and it cost an afternoon. RLS is ENABLED on every table; most
  carry `for all ... using (true) with check (true)`, which is what grants the
  key everything. Three do not: `timesheet_audit` and `leave_log` grant only
  SELECT and INSERT, so the published key cannot rewrite or erase them, and
  `public_holidays` grants SELECT, INSERT and DELETE (no UPDATE — the app never
  updates a holiday row, it adds or removes one).
  **A new table therefore needs its policies written explicitly.** Created
  without them it has RLS on and no policy, which does not error — the anon key
  just sees an empty table and every write fails. `leave_log` shipped that way
  and read back empty while holding 17 rows. Model new audit-shaped tables on
  `timesheet_audit`, not on `entries`.
  These policies exist only in the live database: `capture_schema.sql` does not
  read them, so `schema.sql` cannot rebuild them. See the vault README.
- **A DELETE blocked by RLS is not an error — it reports success.** The policy
  filters the rows away first, so PostgREST deletes the zero rows it can see and
  returns `204`, which is indistinguishable from deleting a row that was not
  there. `public_holidays` shipped with a SELECT policy and no write policies,
  so marking a day failed loudly with `42501` while UNMARKING one announced
  "Public holiday removed" and changed nothing — the row came back on the next
  load. Live from at least 29 Mar to 20 Sep 2026; the last holiday recorded in
  that window was 22 Apr, so King's Birthday on 8 Jun was never flagged and the
  nine people who worked it exported on ordinary categories instead of Public
  Holiday. Write policies added 20 Sep 2026.
  The same shape applies to UPDATE: an update RLS filters out returns `200` with
  an empty array, not an error. Verified on `public_holidays`, which grants no
  UPDATE.
  `db.deleteWhere` now sends `Prefer: return=representation` and returns the
  rows it actually deleted. **A caller that knows a row should exist must check
  that something came back** — see `rbTogglePH`. Deleting zero rows is still
  legitimate elsewhere (`rwSaveTemplates` clears templates for staff who have
  none), so the choke point reports rather than throws.

- **`timesheet_audit` and `leave_log` are append-only — do not try to delete
  from them.** `tsUndoDelete` called `db.delete('timesheet_audit', …)` to tidy
  away the row recording a deletion it was undoing. That never removed anything
  (see the silent-delete note above), so the trail only ever said "deleted": an
  entry deleted and immediately restored left a delete row and nothing else.
  Undo now writes a compensating `restore` / `restore_roster_shift` row instead,
  which is the right shape for an append-only log and keeps the fact that the
  delete happened. The audit actions in use are `manual_entry`, `adjustment`,
  `delete`, `delete_roster_shift`, `restore`, `restore_roster_shift`, `lock`,
  `unlock` — add new ones to BOTH the `actionLabel` map and the
  `tsa-filter-action` dropdown, or they render as a raw string and cannot be
  filtered.

- **A leave entry stores a COPY of its shift's span, not rostered times.**
  `entries` has no `rostered_start`/`rostered_end` — rostered comes from
  `roster_shifts`, live. What `rbMarkLeaveApply` writes into `clock_in`/`clock_out`
  is the shift's span at the moment leave was marked, and it is not a clock
  record (`clock_in_iso` is null on every leave row). That copy is what PAYS:
  `resolveFinalTimes` falls back to it whenever the entry has no finals, so a
  shift resized underneath its leave entry kept paying the old span. Sue McKellar
  15 Jun and 23 Jul 2026 each paid half an hour short against their own roster,
  both locked inside finalised periods, before this was found on 21 Sep.
  `rbSaveShiftTimes` and `rbSplitShift` now call `rbSyncLeaveEntryToShift`.
  **It writes `clock_in`/`clock_out`/`hours` and never `final_start`/`final_end`** —
  finals exist only where a manager set them by hand, must outrank the roster, and
  `resolveFinalTimes` prefers them anyway. A LOCKED entry is skipped on resize
  (with a toast) and blocks a split outright, matching `rbCleanupLinkedEntryOnShiftDelete`.
  Splitting MIRRORS the leave onto both halves — splitting says how a day is
  structured, not whether someone is off, and the common use is dividing a day
  into paid and unpaid leave, so both halves arrive the same type and one gets
  changed from the dropdown.

- **Break exceptions are DATE-EFFECTIVE, and that is load-bearing.** The unpaid
  break is 30 min on any span >= 6h for everyone; `roster_config.break_exceptions`
  (JSON array) overrides the MINUTES for one person, from an `effectiveFrom` date
  FORWARD only. Paid hours are never stored — they are recomputed from times on
  every render and export — so a rule without a date would silently re-rate every
  shift that person has ever worked, including finalised periods already pushed to
  MYOB. `entries.hours` would not catch it; that column is written seven ways and
  is never break-deducted. `breakExceptionFor(empId, date)` returns null for dates
  before the rule starts, and `expectedUnpaidBreakMins(hours, empId, date)` falls
  back to 30 when either is missing — failing toward the standard, never away from
  it. The UI refuses a start date in the past. Stored in `roster_config`, not a
  table of its own, because that is the only config the kiosk loads (on open and
  every 60s), so the clock-out break prompt and payroll agree; a separate table
  would repeat the `GRACE_BY_ROLE` bug and need its own policies, journal trigger
  and backup entry. The column holds `{rules:[...], log:[...]}` — the log is the
  history of every rule ever set, kept beside the rules because a figure that
  changes pay has to be answerable later, and there are single figures of them a
  year. It renders in Analytics beside the other audit views.
  **A rule in force cannot be deleted, only superseded** by a later one (30 min
  ends it). Deleting a live rule would re-rate every day since it started — the
  backdating fault pointed the other way — and would erase the reason the pay was
  what it was. Both rules stay on file, each governing its own window, so past pay
  stays reproducible. A rule that has not started has priced nothing and can go.

- **`_isPartner()` is the only access tier, and Break Exceptions is the first
  thing outside Manager Logins to use it.** `managers.role` is `'manager'` or
  `'partner'`; the scaffolding predates this and already gates account management
  in ~17 places. Break rules are partner-only: managers SEE the rules (a figure on
  a timesheet should be explicable) but not the form, and `bxAdd`/`bxRemove`/`bxSave`
  each re-check rather than trusting a hidden button. Note Eddie Lam is a
  `manager`, so he cannot set his own break exception.

- **Marking a public holiday is payroll data, not decoration.** It pays everyone
  who WORKED that day at the Public Holiday category instead of their weekday or
  evening rate (2.5x in MYOB), and drives the hours cell, the fortnight totals,
  the MYOB preview and the Timesheets badge. It is read from `_publicHolidays`
  at export time, so flagging a day AFTER its period is pushed changes nothing
  that has already been paid.

- **Two `ON DELETE CASCADE` chains**: `employees → entries` and
  `entries → notes`. Deleting one employee row removes **every timesheet they
  ever had**. The app soft-deletes (`active:false`) so it never fires normally —
  a direct API call would. Restore parents before children.
- **`entries.date` is `text`; `roster_shifts.date` is `date`.** Same name,
  different types. Never join or compare them.
- **Two fortnight grids, one day apart.** The roster is Monday-anchored
  (`cycle_start_date`); pay periods are Tuesday-anchored (`PAY_PERIOD_ANCHOR`).
  `fn_start` in `roster_fortnights` is **not** comparable to `fn_start` in
  `timesheet_finalizations`. See the comment above `getFortnightStart()`.
- **The MYOB export dedup key matches entries to a ROSTERED BLOCK by time**, and
  keys on that block's id. It used to key on `shift_id`, which never worked for
  worked time: only leave rows carry a `shift_id`, so the key collapsed to
  (employee, date) and silently dropped the second block of every split shift.
  Duplicate leave rows still collapse — they overlap the same block, so they land
  on the same key — so `rbCleanupLinkedEntryOnShiftDelete` still matters. Re-check
  for duplicates after any bulk roster rebuild.
  Match on **largest overlap**, never first-match: blocks can be contiguous and
  `_rosterShifts` is `push`-mutated in eight places, so first-match would make the
  export order-dependent. Key on block **id**, not `start_time` — two blocks can
  share a start time after a rebuild.
- **No `pay_period_anchor` column exists.** The value is the `PAY_PERIOD_ANCHOR`
  constant; the Settings editor for it was removed because it always failed.

---

## Conventions

- Match the surrounding code: it is dense, comment-heavy where something is
  non-obvious, and uses no semicolon-free or modern-syntax flourishes.
- All DB access goes through the single `db` object (~line 3229). **Keep it that
  way** — that one choke point is what makes the planned write-proxy days of
  work rather than months.
- Escape user text with `escHtml()` before it reaches `innerHTML`. The Staff
  Portal module does this consistently and is the model.
