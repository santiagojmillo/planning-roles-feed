# job-radar

Daily collector of live (≤3 days old) demand & supply planning / S&OP roles from free public sources:
career-ops tracked boards and its reverse sweep over public Greenhouse, Lever, Ashby, Workday and iCIMS boards,
the LinkedIn public jobs listing, Magneto, GetOnBoard and Remotive.

Runs in GitHub Actions at 03:00 Bogotá. Output: `out/latest.json` and `out/latest.md` (only roles not reported before).
Built on [career-ops](https://github.com/career-ops-hq/career-ops) (MIT).

## Optional: Google search via Apify — restores LinkedIn feed-post discovery

Headhunters in Colombia announce senior vacancies as LinkedIn *posts*, not job listings. Google indexes those posts.
Google's own Custom Search JSON API is closed to new customers (shutdown 2027-01-01), so `radar/collect-google.mjs`
runs the 12 date-filtered searches through Apify's [Google Search Results Scraper](https://apify.com/apify/google-search-scraper)
($0.0045 per result page → about $0.05 a night, $1.60 a month, within Apify's free $5/month credit) and adds the
results as `feed_posts` / `jobs` in `out/latest.json`. It is a no-op until one repository secret exists:

1. Apify console → Settings → API & Integrations → copy a **Personal API token** (or create one named `job-radar`).
2. `gh secret set APIFY_TOKEN -R <owner>/<repo>`

A budget guard reads the account's live usage before every run and spreads what is left over the days remaining
in the billing cycle, keeping `RADAR_APIFY_RESERVE_USD` (default $0.30) untouched for anything else that uses the
same credit; when the credit is low it runs fewer searches (highest-value first) or none, and says so in
`stats.budget`. Without the secret the "google" source reports `skipped` and nothing else changes.
