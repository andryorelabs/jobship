# Cut a release

`develop` is the trunk and `main` holds released history only ([ADR-0008](../adr/0008-develop-is-the-trunk.md)). A release is a signed, annotated `v*` tag on `main`. The `release.yml` workflow does the rest.

1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, add its compare-link reference at the bottom, and set `version` in `.claude-plugin/plugin.json`. Squash that into `develop` through a pull request titled `chore: 🔖 release X.Y.Z`.
2. Open a pull request from `develop` to `main` with the same title and merge it with a merge commit. Then update local `main` to that merge commit.
3. Cut the tag with your signing key:

   ```sh
   git tag -s -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. The workflow verifies the tagged commit is on `main`, waits for a green "CI passed" on it, builds the binaries, attests build provenance for every binary and `SHA256SUMS`, and publishes the release with the body taken from the tag's `CHANGELOG.md` section. If that section is missing or empty, the notes script fails and no release is created.
5. Follow the [dogfooding checklist](../guide/dogfooding.md) against the new release.
