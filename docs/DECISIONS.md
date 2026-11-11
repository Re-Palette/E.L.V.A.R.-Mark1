# Owner decisions

- Name: **E.L.V.A.R.** = **E**volving **L**earning **V**irtual **A**daptive **R**easoning. Read aloud as 「エルヴァー」 (English: "El-var"). Use this full name in README, About and persona self-introduction; the TTS/pronunciation hint is 「エルヴァー」.
- License: MIT (`LICENSE`, holder "E.L.V.A.R. contributors").
- Human-protocol assets (`web/src/human/human-data.bin`, `human-bg.webp`, any human reference image): created by the owner, OK to publish.
- Android application id: `com.elvar.mark1`.

## Multi-user platform (see docs/ELVAR_MULTIUSER.md)

- Platform: one shared multi-user service; the 7 principles in CLAUDE.md are absolute.
- AI API keys: every user brings their own (Gemini required). No platform-paid AI keys; usage is still metered per user.
- Signup: open to anyone (email verification, captcha, abuse controls).
- Data store: Supabase (Postgres + RLS, Storage, Auth).
- O2 Google: no shared platform Google OAuth client. Every user creates and enters their own Google OAuth client (current in-app flow). No Google verification / CASA needed.
- O5/O6 Plans: build and test on the free Supabase/Vercel plans; switch to paid plans before public launch.
- O1 Default storage quota: 500MB per user (admin can change per user). Per-file limit 60MB (default unchanged; since P8 it is configurable: ELVAR_MAX_FILE_BYTES / `app.platform_config` `max_file_bytes`, and on the Supabase Free plan the project-wide limit of 50MB applies: set 52428800 there). 2026-11-11 preflight for the first hosted project (Free plan): migration 20 now STARTS the platform at 50MB (inserts `max_file_bytes` = 52428800 if no value is set; the trigger puts the same limit on the `user-files` bucket), because Storage on the Free plan rejects anything over 50MB whatever the bucket says, and a 60MB start would let the database accept reservations that the upload then fails. O1 itself is unchanged: 60MB stays the ceiling and the value used when the row is missing; on a paid plan raise it with ELVAR_MAX_FILE_BYTES=62914560.
- O3 Account deletion: the user chooses at deletion time — delete immediately, or a 7-day grace period during which signing in cancels it.
- O4 Notes at rest: not encrypted beyond database/storage encryption (keeps search working). Secrets are envelope-encrypted per user. (Default; owner may revisit.)
- O7 Privacy law baseline: Japan APPI; design export/deletion so GDPR requests can also be met.
- O8 Old single-owner mode: dropped once multi-user login lands (P2).
