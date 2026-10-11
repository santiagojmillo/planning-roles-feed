# job-radar

Daily collector of live (≤3 days old) demand & supply planning / S&OP roles from free public sources:
career-ops tracked boards and its reverse sweep over public Greenhouse, Lever, Ashby, Workday and iCIMS boards,
the LinkedIn public jobs listing, Magneto, GetOnBoard and Remotive.

Runs in GitHub Actions at 05:00 Bogotá. Output: `out/latest.json` and `out/latest.md` (only roles not reported before).
Built on [career-ops](https://github.com/career-ops-hq/career-ops) (MIT).
