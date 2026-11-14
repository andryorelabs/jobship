# CV structure and Variants

`facts.yaml` accepts optional keys beside `facts:`:

- `profile`: `name` and a `contact` map.
- `experience` and `projects`: Entries with `id`, `name`, `role`, `dates` and a `metadata` map.
- `skills`: groups with `name` and `items`.

A Bullet in `bullets.yaml` may carry `entry` (an Entry id) and `order` (a number). Bullets of an Entry are grouped under it and sorted by `order`; Bullets without `entry` stay in the flat list.

Variants live under `variants:` in `bullets.yaml`:

```yaml
variants:
  startup:
    all: [en]
    none: [enterprise]
```

`all` requires every tag, `any` at least one, `none` excludes tags. `jobship cv build --variant startup` applies the rule and names the output `startup`. `--tag` stays an OR shortcut and can be combined with a Variant. A `--variant` name that is not defined fails with `unknown-variant` when the data dir defines Variants and no `--tag` or `--requirement` is given.

The Typst payload is `{variant, bullets, header, experience, projects, skills}`. `bullets` stays the flat selection; `experience` and `projects` list only Entries that have selected Bullets. `examples/cv/template.typ` renders all of it. A data dir without the new keys builds as before.

## Impact framing and estimates

Impact framing rewrites a task-style CV outcome-first, using only real facts you confirm one by one ([ADR-0016](../adr/0016-impact-framing-is-a-consented-reframing-of-real-facts.md)). Run the `impact-framing` skill: it audits the CV, interviews each Entry about outcomes, gathers Evidence you consent to, and applies the result through an Approval batch. It never invents companies, figures or tools, and never changes dates.

A figure that was calculated rather than measured is an Estimate. Store it on the fact as `estimate`, with the arithmetic and assumptions, and write it in the Dossier as `(source: interview; estimate: 1,000 PDFs/month × 3-5 min ≈ 50-85 h/month)`. A CV line that uses an estimated figure must say so, for example "an estimated ~60 hours a month"; `cv lint` reports `unlabeled-estimate` otherwise. `estimate` is optional, so a data dir without it builds as before.
