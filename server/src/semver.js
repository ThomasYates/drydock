/*
 * Just enough semantic versioning to answer one question: is the release
 * sitting on GitHub newer than the one this container is running?
 *
 * Pulling a full semver library in for that would be silly, and the parts
 * that matter are the parts that are easy to get subtly wrong — "1.10.0"
 * must beat "1.9.0", and a release candidate must sort below the release it
 * leads to. Both are covered by tests.
 */

const CORE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A pre-release identifier is compared as a number when it looks like one. */
const identifier = (part) => (/^\d+$/.test(part) ? Number(part) : part);

/**
 * Break a version string apart, or return null if it is not one at all.
 * Tags like `latest`, `main` and `nightly` land in the null case on purpose:
 * there is no sane way to tell whether they are newer than 1.6.0.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const match = CORE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    pre: match[4] ? match[4].split('.').map(identifier) : [],
  };
}

/** -1, 0 or 1, the way Array#sort wants it. Unparseable versions compare 0. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  // 2.0.0 beats 2.0.0-rc.1: having no pre-release at all is the higher one
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;

  const shared = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === y) continue;
    const xNumeric = typeof x === 'number';
    const yNumeric = typeof y === 'number';
    // numeric identifiers always sort below alphanumeric ones
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  if (left.pre.length === right.pre.length) return 0;
  return left.pre.length > right.pre.length ? 1 : -1;
}

/**
 * True only when both sides are real versions and `candidate` is ahead.
 * Anything ambiguous answers false, so a mis-parse never nags someone to
 * update to something that is not actually newer.
 */
export function isNewer(candidate, current) {
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}
