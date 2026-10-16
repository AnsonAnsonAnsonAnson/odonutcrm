# Test run on Netlify

Netlify is a quick way to put the club online for a trial: the website, member sign-up, stamps, rewards, staff scanning and the admin dashboard all work there. The real launch still runs on your own server with Docker (see the README and [the go-live checklist](06-go-live-checklist.md)), mainly because Apple Wallet needs certificate files that do not fit in Netlify's settings.

## How it runs on Netlify

- The customer, staff and admin pages are served as a static site from `web/dist`.
- The API runs as a Netlify Function (`netlify/functions/api.mts`), which answers `/api/*` and `/healthz`.
- Scheduled jobs (birthday vouchers, campaigns, expiry reminders, pass updates) run every 5 minutes (`netlify/functions/jobs.mts`). On the Docker server they run every minute.
- The database is Postgres. Netlify DB (built on Neon) is the easiest; any Postgres URL works.
- The database tables are created automatically the first time the API starts.

Everything is set up in `netlify.toml`, so there is nothing to change in the code.

## Steps

1. **Import the repo.** In Netlify, choose *Add new project*, then *Import an existing project*, connect GitHub and pick this repository.
   - If Netlify says it found several sites, pick **@odonut/web**.
   - Leave *Base directory* empty. The build command and publish folder come from `netlify.toml`.
2. **Add a database.** Either:
   - add **Netlify DB** to the project (it sets `NETLIFY_DATABASE_URL` for you; Netlify may ask you to claim the database in Neon to keep it beyond the trial period), or
   - set `DATABASE_URL` to any Postgres connection string, for example from Neon or Supabase.
3. **Set environment variables** under *Project configuration*, then *Environment variables*:

   | Name | Value |
   |---|---|
   | `APP_SECRET` | A long random string. Run `openssl rand -hex 32` and paste the result. |
   | `ADMIN_EMAIL` | The email you will sign in to the admin dashboard with. |
   | `ADMIN_PASSWORD` | A strong password for that account. |

4. **Deploy.** Trigger a deploy. When it finishes, open `https://<your-site>.netlify.app/healthz`; it should show `{"ok":true}`.
5. **Sign in.** Go to `/staff/login` with the admin email and password, then set up your store, rewards and branding.

## Member sign-in codes

Members sign in with a 6-digit code sent by email or SMS.

- **Test mode (default).** Without email settings, codes are written to the function log instead of being sent. Open *Logs*, then *Functions*, then *api* in Netlify and look for "Your O! Donut code". Fine for trying it yourself; not for real customers.
- **Real email.** Add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` (from your email provider), and set `APP_ENV=production`. In production mode codes are never written to the log.

## Optional extras

- **Web push offers:** run `npm run vapid -w server` on your computer and add `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
- **Your own domain:** add it in Netlify's *Domain management*. The app uses Netlify's site address automatically; set `PUBLIC_URL` only if you want links in emails to use a different address.

## What the Netlify test can't show

- **Apple Wallet cards.** These need three certificate files. Netlify functions allow only about 4 KB of settings in total, and the certificates are larger than that, so Apple Wallet shows as "not set up". Test it on the Docker server.
- **Google Wallet** has the same size problem with its service-account key.
- **Timing.** Scheduled jobs run every 5 minutes, so a campaign or pass update can take up to 5 minutes to go out.
- **Rate limits** on sign-in codes are counted per running copy of the function, so they are looser than on the server.
- **Cold starts.** The first request after a quiet spell takes a few seconds while the function starts.

## Checking it locally

With the [Netlify CLI](https://docs.netlify.com/cli/get-started/) installed and a local Postgres:

```bash
export NETLIFY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/odonut_netlify
export APP_SECRET=$(openssl rand -hex 32) ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=choose-one
netlify serve --offline --filter @odonut/web
```

This builds the site and functions the same way Netlify does and serves them at http://localhost:8888.
