# Security

## Reporting something

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/ThomasYates/drydock/security/advisories/new)
rather than opening a public issue.

Useful things to include: what an attacker gets, the steps to reproduce it, and
which version you are on.

This is a spare-time project, so please do not expect an enterprise response
time. Fixes for anything that lets an unauthenticated person in, or lets one
account reach another account's data, go out as soon as they are ready.

## Supported versions

The latest release. Drydock is one container with one volume, so updating is
`docker compose pull && docker compose up -d`, and backporting to older versions
is not worth anyone's time.

## What Drydock assumes

It is built for a small group of people who already know each other, on a
network you control. Two things follow from that, and they are choices rather
than oversights:

- **Every signed-in account can see every project.** There are no per-project
  permissions. Anyone you give an account to can read and edit everything.
- **Accounts are admin-created.** There is no public sign-up, no password reset
  by email, and no account recovery. An admin resets a password and hands it
  over.

If you need either of those to be different, Drydock is the wrong tool as it
stands.

## What it does do

- bcrypt password hashing, and a per-account-and-address throttle that backs off
  exponentially after five wrong guesses
- `HttpOnly` session cookies, marked `Secure` when you tell it there is TLS in
  front
- uploads served only to signed-in accounts, never publicly
- a content security policy, `nosniff`, `frame-ancestors 'none'` and the rest on
  every response, plus a rate limit on the API
- the outbound "add an image by URL" request resolves the hostname first and
  refuses anything on a private or internal network, checking every redirect hop
  the same way. That is what stops it being a server-side request forgery hole
- imported archives cannot write outside the uploads folder, whatever the entry
  names inside them claim
- deliberately no Docker socket. Drydock cannot update itself, because a web app
  holding the Docker socket is a web app that is root on the host

## Known limits

- **DNS rebinding on the image-by-URL feature.** The hostname is resolved and
  checked, but the connection is not pinned to the address that was checked, so
  a name that answers with a public address and then a private one microseconds
  later is not covered. Closing it needs control over the socket that Node's
  `fetch` does not expose. The payoff for an attacker is one fetched picture.
- **No audit trail for sign-ins.** The History tab logs what changed in a
  project, not who signed in when.

## Deploying it sensibly

- Put it behind a reverse proxy with TLS, and set `TRUST_PROXY=1` and
  `SECURE_COOKIE=1`.
- Do not expose port 8787 straight to the internet.
- A Cloudflare Access policy, a VPN, or anything else in front makes a good
  second lock. Drydock's own login still applies underneath.
- Back up `/data`. That one directory is everything.
