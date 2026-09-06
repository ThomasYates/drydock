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

The harness lives in `server/test-utils/harness.js` rather than beside the
tests, because Node's default test discovery collects everything under a
directory called `test` — a helper in there gets run as though it were a test.

One rule specific to this suite: a test file that imports anything from `src/`
must import the harness **first**. `src/db.js` opens its database the moment it
is loaded, and the harness is what points it at a temporary directory.

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

## Branches

`main` is what has been released. `beta` is what is being lived with. Work goes
on a branch of its own, named for the thing it does, and opens a pull request
into `beta` rather than into `main`.

```
feature branch  ->  beta  ->  main  ->  tag  ->  release
```

Every push to `beta` republishes `ghcr.io/thomasyates/drydock:beta` and rewrites
the `beta` pre-release, which is how an install set to the beta channel finds
out there is something new. So anything merged there can be used in earnest on a
real install before it is promised to anyone. When what has gathered on `beta`
is worth shipping, it goes to `main` as one pull request, and that is what gets
tagged.

The point of the middle step is that a release stops being the first time
something is used properly. It also means several changes can be tried together,
rather than every fix asking everyone to update.

## Releasing

Maintainers only:

1. Merge `beta` into `main`.
2. Bump the version in `package.json`, `server/package.json` and
   `web/package.json`. All three must match — the release workflow checks.
3. Update `CHANGELOG.md`.
4. Tag it: `git tag v2.1.0 && git push origin v2.1.0`.

That builds and publishes the image to GHCR and creates the GitHub release.
Drydock's own update check reads that release, so a version without one is a
version nobody's install will hear about.
