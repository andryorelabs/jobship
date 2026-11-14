# Impact framing is a consented reframing of real facts

Status: Accepted
Date: 2026-11-15

The agent may rewrite a CV outcome-first, name real clients and add Estimates, but only for facts the user confirms one by one, and never by inventing facts or changing dates.

## Context

A task-style CV ("built a PDF parser") undersells work whose value is an outcome ("cut 50–85 hours of manual review a month"). Turning one into the other means asking for volumes, times and effects the user rarely has measured, so many figures are Estimates, not measurements. The Fact bank had no place for an Estimate, and the `unbacked-number` lint only checks that a number appears in some fact, so an estimated figure could reach a CV looking measured. Reframing can also drift: a tool that "aligns" dates, invents a client name or overstates scope produces a CV the user cannot defend in an interview. The Dossier is the source of derived files ([ADR-0009](0009-the-dossier-is-the-source-of-derived-files.md)), and every derived write goes through an Approval batch.

## Decision

- Allowed, with the user's explicit yes per item: name the real client or company as the Entry, rewrite outcome-first, estimate hours or costs with arithmetic shown, describe sensitive work in neutral wording that stays true.
- Never: invent companies, figures or tools; change or "align" dates (overlaps are shown as concurrent); claim work not done; edit derived files outside an Approval batch.
- A fact may carry an `estimate`: the arithmetic and assumptions behind its figure. A CV line that uses an estimated figure must say so, and `cv lint` enforces it with the `unlabeled-estimate` rule.
- Evidence (the user's own repositories, public product pages, read-only aggregate queries the user grants) is gathered one source at a time with consent, and never includes secrets or personal data.
- The `impact-framing` skill runs this workflow and ends with the groundedness reviewer.

## Consequences

- jobship can produce an outcome-first CV without the user leaving the tool, and every figure in it is traceable to a fact, measured or estimated.
- The interview is longer: each figure, client name and neutral wording needs its own yes.
- An Estimate is always visible as one in the CV, which some users will find less punchy than a bare number.
