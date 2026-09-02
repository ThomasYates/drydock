# Contributing

Thanks for looking. Drydock is a small codebase and the bar is deliberately
plain: it should be obvious what a change does and why, and it should not break
anything that already worked.

## Getting set up

```bash
git clone https://github.com/ThomasYates/drydock.git
cd drydock
npm run install:all
```

Two terminals: `npm run dev:server` and `npm run dev:web`. The web dev server
runs on 5173 and proxies the API and WebSocket to 8787. Data lands in
`server/data/`.

## Before you open a pull request

```bash
npm run check
```

That is lint and the test suite, exactly as CI runs them. Both have to be clean.

## Tests

The suite uses Node's own runner. There are no mocks and no test doubles: every
test stands up the real Express app against a throwaway SQLite file and talks to
it over real HTTP. The things most likely to break in this codebase are the
seams — a cookie that does not stick, a route mounted at the wrong path, a
foreign key that fires on delete — and a stub would agree with whatever the test
expected and prove none of it.

New behaviour wants a test. So does a bug fix: write the test that fails first,
then make it pass. Several tests in here exist because they caught something
real during development, and the comment above them says what.

Run them with `npm test` from the root, or `npm --prefix server run test:watch`
while you work.

One rule specific to this suite: a test file that imports anything from `src/`
must import `./helpers.js` **first**. `src/db.js` opens its file the moment it
is loaded, and helpers.js is what points it at a temporary directory.

## Code

Match what is already there rather than a style guide.

- Comments explain **why**, not what. If a piece of code looks odd, the comment
  should say what would go wrong if it were written the obvious way.
- Error messages are sentences aimed at whoever is using the app, not codes.
- Validate anything arriving from a browser at the route, not in the UI. The UI
  is a convenience; the route is the rule.
- Anything reaching the network or the filesystem on someone's behalf gets
  checked first. `net.js` and `transfer.js` are the two worked examples.

## Schema changes

`db.js` runs `addColumn` on every boot, so a new column is one line and existing
installs pick it up with no migration step. Give it a default that makes an
existing row correct.

Never rename or drop a column. Restore points and exported archives contain rows
written by older versions, and they have to keep loading.

## Commits and pull requests

Small and focused. The description should say what changed and why. Anything
that belongs in release notes, or that changes how someone runs Drydock, should
say so explicitly.

## Releasing

Maintainers only:

1. Bump the version in `package.json`, `server/package.json` and
   `web/package.json`. All three must match — the release workflow checks.
2. Update `CHANGELOG.md`.
3. Tag it: `git tag v2.1.0 && git push origin v2.1.0`.

That builds and publishes the image to GHCR and creates the GitHub release.
Drydock's own update check reads that release, so a version without one is a
version nobody's install will hear about.
