# job-radar

Daily collector of live (≤3 days old) demand & supply planning / S&OP roles from free public sources:
career-ops tracked boards and its reverse sweep over public Greenhouse, Lever, Ashby, Workday and iCIMS boards,
the LinkedIn public jobs listing, Magneto, GetOnBoard and Remotive, and startup boards: YC Work at a Startup (every
company YC marks as hiring) and the monthly Hacker News "Who is hiring?" thread (`radar/collect-startups.mjs`).

Runs in GitHub Actions at 03:00 Bogotá. Output: `out/latest.json` and `out/latest.md` (only roles not reported before).
Built on [career-ops](https://github.com/career-ops-hq/career-ops) (MIT).

## Optional: LinkedIn posts via Google (Apify)

Headhunters in Colombia announce senior vacancies as LinkedIn *posts*, not job listings, and Google indexes some of
those posts. Google's own Custom Search JSON API is closed to new customers (shutdown 2027-01-01), so
`radar/collect-google.mjs` runs up to 7 short, date-filtered searches through Apify's
[Google Search Results Scraper](https://apify.com/apify/google-search-scraper) ($0.0045 per result page → at most
about $0.03 a night, within Apify's free $5/month credit), reads the fresh posts and adds the on-topic vacancy posts as
`feed_posts` in `out/latest.json`. Measured yield is low (Google indexes only a fraction of LinkedIn posts), so the
list is short and ordered by what actually returned results; see the comment at the top of the collector.

It runs in its own workflow step, the only one that receives the secret:

1. Apify console → Settings → API & Integrations → copy a **Personal API token** (or create one named `job-radar`).
2. `gh secret set APIFY_TOKEN -R <owner>/<repo>`

Before searching, a budget guard reads the account's live usage and spreads what is left over the days remaining in
the billing cycle, keeping $0.30 (`RADAR_APIFY_RESERVE_USD`, set in the workflow step if you want another value)
untouched for the 7 am routine; when the credit is low it runs fewer searches or none and says so in
`sources.google` (only a `low_credit` flag is published — no balances; the repo and its logs are public). A night
where every search failed is reported in `skipped`, never as "0 posts". After a fully successful night the results
are kept in the GitHub Actions cache for that UTC day, so a re-run or forced run the same day reuses them instead of
paying again. Without the secret the "google" source reports `skipped: not set up` and nothing else changes.
