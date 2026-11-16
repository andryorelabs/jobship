# Privacy policy

jobship is local-first. It has no server, no account and no telemetry. This page states what it reads, what it stores on your machine and what leaves it. Terms follow [GLOSSARY.md](GLOSSARY.md).

## What jobship reads

- Your data dir: the Profile, the Dossier, the Fact bank, Bullets, the Never-claim list, the Answer bank and the event log.
- Postings from the Sources you configure: public job-board APIs and feeds, and browser-only Sources read in your own logged-in Chrome.
- Gmail, through the Gmail connector you connected to Claude Code. The `inbox` skill reads replies to your applications; the `outreach` skill creates drafts. jobship never sends.
- LinkedIn and other browser pages, through your own Chrome session over the Chrome DevTools Protocol. jobship does not store your credentials.
- Linear, only when the Profile's tracker kind is `linear`, through your own `LINEAR_API_KEY`.

## What jobship stores locally

Everything lives in your data dir and the jobship cache dir, on your machine: the event log, the trackers projected from it, your derived files, Tailored CVs, and downloaded tools such as Typst and the board catalog. Nothing is uploaded to the jobship maintainers. See [the data dir layout](docs/guide/data-dir.md) and [ADR-0003](docs/adr/0003-code-and-personal-data-live-apart.md).

## What leaves your machine

- Requests to the Sources you configure, to fetch Postings.
- Gmail, LinkedIn and Linear requests made through your own sessions and keys. They go to those services under your account and their terms, not to jobship.
- The text Claude Code sends to Anthropic as part of your normal Claude Code session, including content the skills load into it. That is governed by your agreement with Anthropic.
- A download of the release binary and its checksums from GitHub Releases when the launcher fetches it, a download of the pinned Typst release, and a refresh of the board catalog from GitHub.
- An update check against GitHub Releases that asks for the latest version number. It sends no personal data and can be turned off with `JOBSHIP_NO_UPDATE_CHECK=1` (see [configuration](docs/configuration.md)).

jobship never submits a form and never sends a message ([ADR-0002](docs/adr/0002-the-guard-fails-closed.md)).

## Questions

Open an issue, or report a vulnerability privately as described in [SECURITY.md](.github/SECURITY.md).
