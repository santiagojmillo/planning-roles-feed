# job-radar

Daily collector of live (≤3 days old) demand & supply planning / S&OP roles from free public sources:
career-ops tracked boards and its reverse sweep over public Greenhouse, Lever, Ashby, Workday and iCIMS boards,
the LinkedIn public jobs listing, Magneto, GetOnBoard and Remotive.

Runs in GitHub Actions at 03:00 Bogotá. Output: `out/latest.json` and `out/latest.md` (only roles not reported before).
Built on [career-ops](https://github.com/career-ops-hq/career-ops) (MIT).

## Optional: Google search (free) — restores LinkedIn feed-post discovery

Headhunters in Colombia announce senior vacancies as LinkedIn *posts*, not job listings. Google indexes those posts;
`radar/collect-google.mjs` runs ~18 date-filtered searches a day through Google's Programmable Search JSON API
(free tier: 100 queries/day) and adds the results as `feed_posts` / `jobs` in `out/latest.json`. It is a no-op until two
repository secrets exist:

1. Create a Programmable Search Engine at https://programmablesearchengine.google.com/ → *Add* → choose **Search the entire web** → copy its **Search engine ID** (`cx`).
2. Create an API key at https://console.cloud.google.com/apis/credentials (enable "Custom Search API" for the project).
3. Add both as secrets: `gh secret set GOOGLE_CSE_KEY -R <owner>/<repo>` and `gh secret set GOOGLE_CSE_CX -R <owner>/<repo>`.

The next run picks them up automatically. Without them the "google" source reports `skipped` and nothing else changes.
