# Contacts are researched in the user's browser

Status: Accepted
Date: 2026-11-14

The agent may research up to three Contacts per active Lead in the user's own browser, and stores their detail outside the Event log so it can be pruned.

## Context

Outreach works better when it reaches the hiring manager and ties to something they said recently. Commercial finders such as Apollo build verified emails from millions of connected inboxes, which a single-user tool cannot reproduce. [ADR-0011](0011-linkedin-is-read-in-the-users-browser.md) lets the agent read only the user's own LinkedIn profile. Regulators have fined tools that collect contact data at scale, such as the CNIL fine on Kaspr in 2024, and guessed emails sent at volume hurt the sender's reputation. The Event log is append-only ([ADR-0001](0001-event-log-is-the-source-of-truth.md)), so personal detail written there could never be deleted.

## Decision

- The `contact` skill, started by the human for one Lead, may look up at most three people at human pace: the Posting text, a LinkedIn people search in the user's browser, the company team page and its GitHub org. It reads public profile data and posts from the last 90 days only, never contact details visible only to connections, and never crawls in bulk.
- A `contact.found` Event records only the Contact's name, role and channel. Email, evidence and recent items live in `contacts/<key>.json` in the data dir, and `jobship contact prune` deletes them once the Application has been closed for 90 days.
- Every email carries an Email confidence: published, pattern or guess. Nothing is labeled verified, and jobship never probes mail servers.
- This amends ADR-0011 for Contacts only; Onboarding still reads only the user's own profile.

## Consequences

- `/jobship:outreach` can address the right person and cite what they said.
- The user accepts more LinkedIn account risk than ADR-0011 alone, bounded by the three-person cap.
- Emails remain unverified; the human decides whether a guess is worth sending.
