TA777Gaming — Dragon vs Tiger Complete Replacement

Included
- src/App.jsx: complete replacement App.jsx with all existing customer/admin features retained plus 4 AC games:
  1) Graph Game
  2) Horse Racing
  3) Spin Wheel
  4) Dragon vs Tiger
- TA777Gaming_Dragon_Tiger_migration.sql: NEW Dragon vs Tiger database tables + secure server-side RPCs and horse betting RPC grants.

Dragon vs Tiger
- Dragon 🐉 and Tiger 🐅 are displayed as two large selectable animal cards.
- 10-second betting window.
- Player must select one animal before betting.
- Server randomly chooses Dragon or Tiger when betting closes.
- Winning bet pays exactly 2x the stake.
- Losing stake is deducted and not refunded.
- Multiple players can bet independently in the same round.
- 3-second result break, then a new round starts automatically.
- Wallet debits, payouts, and ledger entries happen server-side.

Horse betting fix
- Horse must be selected before the bet button enables.
- Selected horse is visibly highlighted.
- Betting button explicitly shows the selected horse.
- Betting is locked automatically when the 10-second window closes.

Installation
1. Back up the current repository.
2. Replace your existing src/App.jsx with the included App.jsx.
3. Open Supabase SQL Editor for the same TA777Gaming project.
4. Run TA777Gaming_Dragon_Tiger_migration.sql.
5. Deploy the site.
6. Sign in with a customer account and test with AC tokens.

Important
- The SQL migration is for the NEW Dragon vs Tiger backend and horse RPC grants. It does not replace your existing Spin, Graph, deposit, or withdrawal migrations.
- The App continues to use your existing ./supabaseClient.js and environment variables.
- Do not put a Supabase service-role key in the frontend.
