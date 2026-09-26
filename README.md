TA777Gaming — Graph Game + Horse Racing replacement

This package preserves the source project's account, customer dashboard, deposit/withdrawal request UI, admin dashboard and existing controls. The game center has Graph Game and Horse Racing.

GRAPH GAME UPDATE
- No graph/line visualization: displays the multiplier only.
- Each round has a 10-second betting window. Players must place bets before it closes.
- Minimum stake is 70 AC. There is no application-level maximum; available wallet balance applies.
- Multiplier starts at 0.1x and rises by 0.1x every 0.5 seconds (fixed speed), up to 10.0x.
- Server selects a random crash target in 0.1x steps from 0.1x to 10.0x. Cash out before reset to receive stake × cash-out multiplier; active bets at reset are marked lost.
- After reset, a new 10-second betting window begins.

INSTALL
1. Back up your repository.
2. Replace your src/App.jsx, src/main.jsx, src/styles.css, src/supabaseClient.js, index.html, package.json, vite.config.js with files in this package.
3. Run the full TA777Gaming_TWO_GAMES_MIGRATION.sql in the Supabase SQL Editor. It includes the base game tables and the new graph RPC definitions. If you already ran an earlier migration, this file uses CREATE OR REPLACE and ADD COLUMN IF NOT EXISTS for the updated graph pieces, but review the SQL before running against production.
4. Set Netlify environment variables VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY. Never use a service-role key in browser code.
5. Build with npm install && npm run build.

IMPORTANT
The SQL has not been run against your live Supabase project. AC game tokens are separate from the cash/deposit wallet. Test with staging accounts before live use. Graph multiplier outcomes are controlled by database time and server-generated random targets; do not treat the game as guaranteed income.
