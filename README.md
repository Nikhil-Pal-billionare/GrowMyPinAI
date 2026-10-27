# GrowMyPin Autopilot

Etsy / Shopify sellers ke liye SaaS: roz 5 AI pins banake unke Pinterest pe post karta hai.
Billing: Rs 999 monthly base + views milestone charges, sab UPI AutoPay se.

Stack: static HTML (public/) + Vercel serverless (api/) + Supabase. No npm packages, no build step.

## Files

```
public/index.html          landing page + signup / login
public/app.html            user dashboard (setup, products, pins, billing)
public/terms.html          terms + privacy (Pinterest and Razorpay review ke liye zaroori)
api/_lib.js                shared helpers (not a route)
api/config.js              public config for browser
api/me.js                  account + stats + settings save
api/products.js            Shopify / Etsy import, manual add, delete
api/pinterest-connect.js   Pinterest login link
api/pinterest-callback.js  Pinterest login return
api/boards.js              list / create boards
api/billing.js             UPI AutoPay start + verify
api/razorpay-webhook.js    payment + mandate events
api/worker.js              engine: views, milestones, renewals, pin making + posting
supabase/schema.sql        database tables
.github/workflows/worker.yml  runs the worker every 15 min
vercel.json                worker gets 300s time limit
```

## Setup (one time)

### 1. Supabase
1. New project banao.
2. SQL Editor -> `supabase/schema.sql` paste -> Run.
3. Authentication -> Providers -> Email ON. Fast testing ke liye "Confirm email" OFF kar sakte ho.
4. Authentication -> URL Configuration -> Site URL = your Vercel URL.
5. Settings -> API se copy karo: Project URL, anon key, service_role key.

### 2. GitHub + Vercel
1. New GitHub repo (example: `GrowMyPin-Autopilot`), saari files same folder structure mein daalo.
2. Vercel -> Import repo -> Deploy (koi build setting nahi chahiye).
3. Vercel -> Settings -> Environment Variables (neeche list) -> add karke Redeploy.

### 3. Environment variables (Vercel)

| Name | Value |
|---|---|
| SUPABASE_URL | Supabase project URL |
| SUPABASE_ANON_KEY | Supabase anon key |
| SUPABASE_SERVICE_KEY | Supabase service_role key (secret) |
| APP_URL | https://your-app.vercel.app (no slash at end) |
| APP_SECRET | any long random text |
| CRON_SECRET | any long random text (same in GitHub secret) |
| PINTEREST_APP_ID | Pinterest developer app id |
| PINTEREST_APP_SECRET | Pinterest app secret |
| PINTEREST_API_BASE | optional. Trial access mein `https://api-sandbox.pinterest.com`, Standard milne ke baad hata do |
| ANTHROPIC_API_KEY | Claude API key |
| CLAUDE_MODEL | optional, default `claude-haiku-5-5` |
| OPENAI_API_KEY | OpenAI API key (images) |
| OPENAI_IMAGE_MODEL | optional, default `gpt-image-1-mini` |
| OPENAI_IMAGE_QUALITY | optional, `low` / `medium` / `high`, default `medium` |
| RAZORPAY_KEY_ID | Razorpay key id |
| RAZORPAY_KEY_SECRET | Razorpay key secret |
| RAZORPAY_WEBHOOK_SECRET | webhook secret you set in step 5 |
| ETSY_API_KEY | optional. Etsy auto-import ke liye (format `keystring:sharedsecret`). Na ho to Etsy users manual add karenge |
| BASE_PRICE | optional, default 999 |
| MANDATE_MAX | optional, default 6500 |
| PAUSE_ON_PENDING | optional, `1` = milestone payment pending ho to posting pause (default), `0` = pause nahi |

### 4. Pinterest app
1. developers.pinterest.com -> My apps -> Connect app.
2. Redirect URI: `https://your-app.vercel.app/api/pinterest-callback`
3. Scopes: boards:read, boards:write, pins:read, pins:write, user_accounts:read
4. Privacy policy URL: `https://your-app.vercel.app/terms.html`
5. Trial access mein pins public nahi hote. Standard access ke liye app ka demo video record karo
   (signup -> connect Pinterest -> boards -> product import -> pin post hota hua) aur request bhejo.

### 5. Razorpay
1. Dashboard -> Recurring payments / UPI AutoPay enable karwao (support se, agar off hai).
2. Settings -> Webhooks -> Add: URL `https://your-app.vercel.app/api/razorpay-webhook`
   Events: payment.captured, payment.failed, token.confirmed, token.cancelled, token.paused, token.rejected
   Secret set karo, wahi `RAZORPAY_WEBHOOK_SECRET` mein daalo.

### 6. GitHub Actions (scheduler)
Repo -> Settings -> Secrets and variables -> Actions -> New secret:
- `APP_URL` = https://your-app.vercel.app
- `CRON_SECRET` = same as Vercel

Actions tab -> "Autopilot worker" -> Run workflow (pehla test manually).

## Billing logic (short)
- Signup -> setup -> "Start UPI AutoPay": Rs 999 paid + mandate (max Rs 6,500 per debit, as_presented).
- Har din worker Pinterest views (current 30-day cycle) fetch karta hai.
- Milestone cross hote hi usi din difference ka debit (25k=1499, 50k=2500, 1L=4000, 2L+=5500). Pending ke time posting pause.
- Cycle end se 2 din pehle next Rs 999 debit. Paid nahi hua to cycle end pe posting pause (past_due).
- Mandate cancel -> account locked, posting band. Bacha hua milestone "failed" dues mein rehta hai,
  restart pe pehle payment mein add hota hai.

## Capacity
Ek worker run (~4 min) mein ~3 pins banti hain. Har 15 min = ~280 pins/day = ~55 users at 5 pins/day.
Isse zyada users pe: workflow mein 2-3 parallel jobs add karo (worker jobs ko safely claim karta hai),
ya Vercel Pro lo.

## Test checklist
1. Signup -> Setup details save -> Pinterest connect -> boards save -> products import.
2. Razorpay TEST keys se AutoPay start karo.
3. GitHub Action manually run -> Pins tab mein queued/posted dekho.
4. Milestone test: real Pinterest account jo 25k+ monthly views pe ho, usse connect karo,
   Supabase `accounts` mein `last_daily_run` khali karo, worker run karo ->
   `charges` table mein milestone 1499 pending aana chahiye.
