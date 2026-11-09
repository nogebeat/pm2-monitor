"use strict";

/**
 * lib/services/updates/semver.js — comparaison de versions SemVer, sans
 * dépendance.
 *
 * Deux formes volontairement différentes :
 *  - la version INSTALLÉE (package.json) peut porter un suffixe de
 *    pré-version (`4.2.0-beta.1`) : parseVersion() l'accepte ;
 *  - un TAG DE RELEASE n'est pris en compte que s'il est strictement
 *    `vMAJOR.MINOR.PATCH` : parseReleaseTag() rejette tout le reste (`v4.2`,
 *    `4.2.0`, `v4.2.0-rc1`, `latest`…), pour ne jamais proposer autre chose
 *    qu'une version stable explicitement nommée.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(value) {
  const m = VERSION_RE.exec(String(value || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

function parseReleaseTag(tag) {
  const m = RELEASE_TAG_RE.exec(String(tag || ""));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: null };
}

/** <0 si a < b, 0 si égales, >0 si a > b. Une pré-version est inférieure à la version finale correspondante. */
function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** "major" | "minor" | "patch" si `target` est strictement plus récente que `current`, sinon null. */
function classifyUpdate(current, target) {
  if (compareVersions(target, current) <= 0) return null;
  if (target.major !== current.major) return "major";
  if (target.minor !== current.minor) return "minor";
  return "patch";
}

module.exports = { parseVersion, parseReleaseTag, compareVersions, classifyUpdate };
