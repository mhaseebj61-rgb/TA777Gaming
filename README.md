# TA777Gaming — Dragon vs Tiger UI + Timer + Gaming Theme Fix

## Included
- `src/App.jsx` — complete replacement application file with the existing dashboard/admin/customer/game features preserved from the supplied TA777Gaming build.
- `src/supabaseClient.js` — existing browser Supabase client.
- `src/main.jsx` — Vite React entry file.
- `TA777Gaming_Dragon_Tiger_FIXED.sql` — Dragon vs Tiger database migration/RPC.

## Fixes in this version
1. Dragon vs Tiger betting countdown is driven from the round's server timestamp and a 100ms local display clock. At 0 seconds the betting controls are disabled immediately, and the client refreshes immediately after the server deadline.
2. Server-side SQL continues to enforce the same 10-second betting deadline, so changing the browser timer cannot extend betting.
3. Dragon and Tiger are rendered as detailed inline vector illustrations instead of emoji-only animals.
4. Game Center gets a premium gaming/arena visual treatment.
5. Added synthesized gaming background music using the browser Web Audio API; no MP3 file is required. Mobile browsers require one user tap on `TURN GAMING MUSIC ON` before audio can play.

## Installation
1. Back up your current `src/App.jsx`.
2. Replace `src/App.jsx`, `src/supabaseClient.js`, and `src/main.jsx` with the files in this package.
3. Run `TA777Gaming_Dragon_Tiger_FIXED.sql` in Supabase SQL Editor if the Dragon/Tiger migration has not already been applied.
4. Build and deploy normally.

Do not put a Supabase service-role key in the browser environment.
