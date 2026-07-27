# Contributing to APEX FORMULA 2026

Thanks for helping improve the simulator. Bug fixes, performance work,
accessibility improvements, tests, documentation, and original gameplay ideas
are welcome.

## Before you start

- Search existing issues before opening a new one.
- For a substantial feature or redesign, open a proposal first so scope and
  technical direction can be agreed before implementation.
- Keep the public game fictional. Do not add real teams, drivers, sponsors,
  liveries, logos, broadcasts, or unlicensed third-party assets.
- Do not commit credentials, `.env` files, Vercel linkage, generated MP3s, or
  build output.

## Local setup

The browser game has no install step. Serve the repository with Python:

```bash
python3 -m http.server 8341
```

Node.js 24 is required for the bit-stable automated checks:

```bash
npm ci
npm test
```

The geometry test is verbose. During focused work, use a narrower script such
as `npm run test:tracks`, `npm run test:physics`, or `npm run test:race`, then
run the complete suite before opening a pull request.

## Pull requests

1. Create a focused branch from `main`.
2. Keep unrelated formatting or generated changes out of the patch.
3. Add or update tests when behavior changes.
4. Run `npm test` and `npm run build`.
5. Explain the user-visible change, validation performed, and any tradeoffs in
   the pull request template.

By submitting a contribution, you agree that it is licensed under Apache 2.0
as described in section 5 of the project license. Only submit work you have the
right to contribute.

## Assets and dependencies

New binary assets require a documented source, creator, creation method, and
license in `ASSET_PROVENANCE.md`. Do not copy material from a website, game,
broadcast, mapping product, or social platform without explicit compatible
permission.

Avoid new runtime dependencies when a small local implementation is practical.
If a dependency is necessary, include its exact version and license in
`THIRD_PARTY_NOTICES.md` and place its license text in `LICENSES/`.

## Conduct and security

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report
security concerns privately according to [SECURITY.md](SECURITY.md), not in a
public issue.
