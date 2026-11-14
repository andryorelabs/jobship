# Companies are discovered, not curated

Status: Accepted
Date: 2026-11-14

jobship finds the companies whose ATS boards a Sweep reads through Discovery, and ships no company list.

## Context

ATS Sources read one board per company, so a Sweep needs company slugs. Asking the human to add careers URLs one by one left fresh setups with no ATS Postings and a misconfigured warning on every sweep. Shipping a curated company list was ruled out: it goes stale, picks companies for the user, and would be personal-looking data in the repository. Paid aggregators were ruled out by [ADR-0013](0013-jobship-ships-a-board-catalog.md). Research on 2026-11-14 found free public sources that reveal boards: the Common Crawl CDX index lists board URLs for Greenhouse, Ashby, Workable and SmartRecruiters; the HN Who is hiring thread links ATS boards each month; Workable has a public cross-company search. Lever blocks Common Crawl's crawler.

## Decision

- `jobship discover` is optional. It finds candidate boards in the Common Crawl CDX index and the HN Who is hiring thread, verifies each one through the ATS public GET API, and keeps only companies with at least one Posting that passes the Gates.
- Discovered companies are stored in the data dir as Saved companies with an origin and a check date, never in the repository ([ADR-0003](0003-code-and-personal-data-live-apart.md)). Companies the human added are never removed automatically.
- A Sweep reads Saved companies when the Profile names no Sources. No Saved companies is a normal state, not a warning.
- Workable's public search is a catalog feed board marked `stability: unofficial`.
- Lever boards are found by the agent's own web search, because Lever blocks Common Crawl.
- This amends ADR-0013: Discovery requests are GETs to Common Crawl and the ATS public APIs, cached and retried with backoff.

## Consequences

- A fresh setup gets ATS Postings without curating anything.
- Discovery depends on Common Crawl's monthly index, which is often slow and returns gateway errors; results are cached for 30 days.
- Discovered boards drift; they are checked again after 30 days and dropped when nothing passes the Gates.
