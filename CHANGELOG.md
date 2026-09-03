# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org).

## Unreleased

### Fixed

- **Canvas pan and zoom on a trackpad.** A two-finger swipe on the moodboard or
  the story graph zoomed instead of moving the canvas, and one flick took the
  zoom right across its range. A swipe now pans, in both directions — sideways
  movement was being discarded entirely. Pinch-to-zoom got its own sensitivity
  rather than sharing the mouse wheel's, which had made a full pinch across the
  trackpad worth a 27% change in zoom. A mouse wheel behaves exactly as it did.
- The wheel pan/zoom toggle now appears on the story graph as well as the
  moodboard. The setting was always shared between them, but only the moodboard
  offered a way to change it.

## 2.0.0

The first public release.

### Added

- **Search across everything.** `Ctrl/Cmd + K` from anywhere searches notes on a
  moodboard, cards, story beats, board names, project names and uploaded
  filenames, across every project or narrowed to one. Picking a result frames
  the thing on the canvas and selects it, rather than only opening the tab.
- **Project export and import.** A project's Settings tab exports one zip
  holding boards, nested boards, cards, story threads and every picture. Import
  on the Projects page rebuilds it as a new project with fresh ids, in this
  install or any other — a backup, a way to move machines, and a way to hand a
  whole project to someone else.
- **Update checking.** Drydock reads the public GitHub releases list every six
  hours and shows a notice when a newer version exists, with the two commands
  that take it. Admins get a **Check for updates** button under People and
  settings. `UPDATE_CHECK=0` switches it off entirely.
- **Card detail.** Cards gained checklists, owners and due dates. The card face
  now shows tags, checklist progress, the owner, and the due date in red once it
  has passed.
- A published multi-architecture image at `ghcr.io/thomasyates/drydock`, so
  installing is a compose file rather than a build.
- A test suite: 126 tests against a real server, a real database and real HTTP.
- ESLint over both halves of the repo, and CI that runs lint, tests, the
  frontend build, and a container that has to answer its health check.

### Changed

- Compose is now `compose.yaml` and pulls the published image.
  `compose.build.yaml` covers building from source.
- `SECURE_COOKIE` alone now decides whether the session cookie is marked
  `Secure`. It previously followed `TRUST_PROXY` as well, which meant a
  plain-HTTP reverse proxy stopped anyone from signing in at all.
- `GET /api/projects/:id` returns top-level story threads only. It previously
  included planner pages, disagreeing with the story route about what a thread
  is.
- Duplicating a card copies its notes, tags, owner, due date and checklist
  rather than only the title.
- Running the server straight from a checkout puts its data in `server/data/`
  instead of trying to create `/data` at the root of the filesystem.
- The Express app moved into `app.js` behind a factory function, so tests can
  mount it without the entry point's timers and listener coming along.

### Fixed

- **Adding an image by URL was a server-side request forgery hole.** Any
  signed-in person could point it at an address on the host's own network and
  read the response back. The hostname is now resolved and every address it
  points at is checked against the private, loopback, link-local and
  carrier-grade NAT ranges, with every redirect hop checked the same way.
- A card could be moved into a column belonging to a different project.
- The login throttle map grew without limit; it is now swept hourly.
- `SIGTERM` closes the WebSocket clients and checkpoints the database, so
  `docker stop` leaves a clean file rather than one the next boot has to
  recover.
- Enter in a card checklist adds a step and moves the caret to it.
- The health check honours `PORT` instead of assuming 8787.

### Security

- A content security policy and the usual hardening headers on every response.
- A rate limit on the API.
- Checklist ids, tags, due dates and assignees arriving from a browser are
  validated at the route rather than trusted.
- Imported archives cannot write outside the uploads folder, whatever the entry
  names inside them claim.
- Release notes fetched from GitHub are rendered as plain text, never as markup.

---

Versions before 2.0.0 were never published.
