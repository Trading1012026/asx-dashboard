# Setup — about 20 minutes, once

No command line. Everything below happens in a web browser.

When you're done you'll have a dashboard at a web address you can open from any
device, that updates itself on a schedule forever, for free, with no server and
no billing cycle to run out of.

---

## 1. Create a GitHub account (2 min)

Go to **[github.com/signup](https://github.com/signup)** and sign up. Free plan.
Verify your email — GitHub won't let you run scheduled jobs until you do.

---

## 2. Create the repository (2 min)

1. Go to **[github.com/new](https://github.com/new)**
2. **Repository name:** `asx-dashboard`
3. Select **Public**

   It has to be public — that's what makes the automation and hosting free.
   This is safe: only public market data is published. Your holdings are
   stored in your browser and never uploaded. More on that at the bottom.
4. Leave everything else alone. Click **Create repository**.

---

## 3. Upload the files (5 min)

On the empty repository page, click **uploading an existing file**.

Now open the `asx-dashboard` folder I sent you. Select **everything inside it**
(`Cmd + A`) and drag it into the browser window.

> **One catch:** macOS Finder hides folders starting with a dot, and there's an
> important one called `.github`. Press **`Cmd + Shift + .`** in Finder to show
> hidden files before you select everything. That keyboard shortcut toggles it
> back off afterwards.
>
> If `.github` doesn't make it across, the automation won't run. You can check
> after uploading: the file list should include a `.github` folder.

Scroll down and click **Commit changes**.

---

## 4. Turn on GitHub Pages (2 min)

1. In your repository, click **Settings** (top right of the repo, not your account)
2. Left sidebar → **Pages**
3. Under **Build and deployment**:
   - **Source:** Deploy from a branch
   - **Branch:** `main`, and change the folder dropdown from `/ (root)` to **`/docs`**
4. Click **Save**

Wait 2–3 minutes. Reload the page and it'll show your address:

```
https://<your-username>.github.io/asx-dashboard/
```

It'll say "no data yet" for now. That's expected — nothing has fetched anything.

---

## 5. Run the first data build (5 min)

1. In your repository, click the **Actions** tab
2. If it asks you to enable workflows, click the green **I understand my
   workflows, go ahead and enable them**
3. Left sidebar → **Refresh dashboard data**
4. Right side → **Run workflow** ▾ → leave mode as `full` → green **Run workflow**

It'll appear in the list within a few seconds. Click into it to watch.

**This first run takes 5–10 minutes** because it downloads 180 days of ASIC
short-position history and builds the stock universe from scratch. Every run
after this is under a minute.

When it finishes with a green tick, open your dashboard address. Data.

---

## 6. Add your holdings (2 min)

On the dashboard, go to the **Portfolio** tab → **Edit holdings** → add each
position (code, units, average buy price) → **Save**.

These are stored in your browser only. Use **Export** to save them to a file,
and **Import** on another computer or browser to load them there.

---

## 7. Share it (1 min)

The dashboard address is public — send it to anyone and they see the short-interest
charts, signals and watchlist. They will *not* see your portfolio, because it isn't
published.

To share that too: **Portfolio** → **Edit holdings** → **Copy share link**. The link
carries your positions inside it, so whoever opens it sees the complete dashboard with
the Portfolio tab filled in.

Why not simply publish the holdings? The repository is public, and anything committed to
a public repository stays in its history permanently even if deleted later. The share
link gives the same result for the person you send it to, without your positions and cost
base sitting at an address anyone could find. Treat the link like the information it
contains.

---

## That's it

From now on it runs itself:

| When | What |
|---|---|
| **08:00 AEST, Mon–Fri** | Full sweep — ASIC short positions, universe, prices, signals |
| **Hourly, 10:00–16:00 AEST** | Prices, macro and announcements; signals re-scored |
| **Never** | Anything while the market is shut |

The **Force refresh** button on the dashboard opens the workflow so you can run
it on demand.

---

## Making changes later

Any file can be edited straight on GitHub — click the file, click the pencil
icon, edit, **Commit changes**. Pages redeploys within a minute.

To replace files wholesale, use **Add file → Upload files** again.

---

## Two things to know

**Why the repository is public.** GitHub gives unlimited automation minutes and
free hosting to public repositories; private ones are metered and Pages needs a
paid plan. So public it is. What gets published is ASIC short-position data, ASX
prices, and the signals computed from them — all of which is public information
already. Your holdings never leave your browser, which is why the Portfolio tab
is empty when you open the dashboard on a new device until you import them.

**A dormancy rule.** GitHub switches off scheduled workflows in repositories with
no activity for 60 days. Yours commits data every weekday, so this shouldn't
trigger. If it ever does, GitHub emails you and there's a button to switch it
back on.
