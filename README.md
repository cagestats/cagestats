# Cage Stats: web dashboard

The dashboard is a static site (index.html, app.js, config.js, icon.svg) hosted on GitHub Pages. It reads from Supabase.

## How it fits together

- **Watch:** uploads each match after the final whistle. If it's offline, it retries the next time the app opens.
- **Supabase:** stores your matches and handles sign-in. `supabase/schema.sql` sets everything up.
- **Dashboard:** you sign in with an emailed link and link your watch once with a 6-character code. After that, every match shows up.

## One-time setup

### 1. Database (2 min)
1. Open your Supabase project and go to **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**. It should finish with "Success. No rows returned".

### 2. Sign-in emails (1 min)
1. In Supabase, go to **Authentication → URL Configuration**.
2. Set **Site URL** to your dashboard address, `https://imobbcs.github.io/cagestats/`.
3. Add the same address under **Redirect URLs**.

### 3. Dashboard settings
Put your **Project URL** and **publishable key** in `config.js`. Both are public by design, because the database rules decide what each signed-in user can see. Never put the `service_role` or secret key here.

### 4. Hosting on GitHub Pages
1. Push this folder to a GitHub repository named `cagestats`.
2. Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.
3. The site appears at `https://<your-username>.github.io/cagestats/`.

### 5. Watch settings
1. Open `gradle.properties` in the watch project and fill in:
   ```
   cagestats.supabaseUrl=https://xxxx.supabase.co
   cagestats.supabaseKey=sb_publishable_...
   cagestats.dashboardUrl=https://<your-username>.github.io/cagestats/
   ```
2. Press **Run** in Android Studio.

## Linking your watch

1. On the watch's Home screen, tap **Link to web** under the Start button. A code appears, e.g. `K7M 2QX`.
2. Open the dashboard, sign in, and type the code. It's valid for 30 minutes.
3. The watch shows **LINKED** within a few seconds and uploads every match it has stored.

## Good to know

- Matches recorded before linking are not lost. They upload as soon as the watch is linked.
- Uploading the same match twice never creates a duplicate.
- Deleting a match on the watch also deletes it online. Deleting it on the dashboard leaves the watch's copy alone.
- Supabase's built-in email service only sends a few sign-in emails per hour. That's fine for one person; for a group, set up your own email sender under **Authentication → Emails**.
