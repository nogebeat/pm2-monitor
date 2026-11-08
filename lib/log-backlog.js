"use strict";

/**
 * lib/log-backlog.js — construit l'historique affiché à la sélection d'un
 * process (GET /api/processes/:id/logs/tail, voir lib/routes/logs.js).
 *
 * Le problème de départ : PM2 écrit stdout et stderr dans DEUX fichiers
 * séparés (`*-out.log` / `*-error.log`) qui ne portent aucun horodatage
 * (sauf option `time` / `log_date_format`). Les relire séparément puis les
 * concaténer (tout stdout, puis tout stderr) donne un historique où la fin
 * de la liste — celle sur laquelle l'auto-scroll se positionne — est
 * toujours composée de stderr, parfois très ancien, alors que les lignes
 * stdout récentes sont rangées plus haut : on a l'impression de ne voir
 * que les erreurs.
 *
 * Le LogStore (lib/log-store.js), alimenté par le bus PM2 en direct, garde
 * au contraire UN horodatage par ligne et l'ordre réel stdout/stderr. On
 * l'utilise donc comme source principale ; les fichiers natifs ne servent
 * qu'à compléter l'historique PLUS ANCIEN que ce que le LogStore a vu
 * (process déjà lancé avant le monitor), et seulement quand on peut
 * prouver qu'il n'y aura pas de doublon (voir olderNativeLines()).
 *
 * Fonctions pures, sans accès disque : testées dans
 * test/unit/log-backlog.test.js.
 */

// "2026-11-07 10:00:00: msg", "2026-11-07T10:00:00.123Z: msg",
// "2026-11-07 10:00:00 +01:00: msg" (préfixes ajoutés par PM2 avec `time: true`).
const TS_PREFIX = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?): ?/;

/** Sépare un éventuel préfixe d'horodatage PM2 du reste de la ligne. */
function splitNativeTimestamp(rawLine) {
  const line = String(rawLine).replace(/\r$/, "");
  const m = TS_PREFIX.exec(line);
  if (!m) return { at: null, text: line };
  const at = Date.parse(m[1]);
  if (!Number.isFinite(at)) return { at: null, text: line };
  return { at, text: line.slice(m[0].length) };
}

function toNativeRows(type, lines) {
  return (lines || []).map((raw) => {
    const { at, text } = splitNativeTimestamp(raw);
    return { type, text, at };
  });
}

/**
 * Parmi les lignes natives d'UN flux, renvoie celles qui sont PLUS ANCIENNES
 * que ce que le LogStore a déjà vu pour ce même flux.
 *
 *  - LogStore vide pour ce flux : il n'a rien vu passer depuis qu'il existe,
 *    donc tout ce qui est dans le fichier natif est antérieur → tout est gardé.
 *  - Sinon, le LogStore doit correspondre EXACTEMENT à la fin du fichier
 *    natif (mêmes textes, même ordre) — c'est le cas normal, puisque les deux
 *    sont alimentés par le même flux PM2. On retire alors ce suffixe commun.
 *  - Si ce n'est pas le cas (monitor arrêté un moment, rotation, fichier
 *    tronqué…), on ne peut pas savoir où s'arrête le recouvrement : on
 *    renonce aux lignes natives plutôt que d'afficher des doublons.
 */
function olderNativeLines(nativeRows, storeTexts) {
  if (!storeTexts.length) return nativeRows;
  const n = nativeRows.length;
  const s = storeTexts.length;
  if (s <= n) {
    for (let i = 0; i < s; i++) {
      if (nativeRows[n - s + i].text !== storeTexts[i]) return [];
    }
    return nativeRows.slice(0, n - s);
  }
  // Le LogStore a plus de lignes que la fenêtre native lue : le fichier natif
  // ne peut alors rien contenir de plus ancien que le LogStore.
  return [];
}

/**
 * Ordre des lignes natives (sans horodatage commun) : chronologique si
 * TOUTES ont un horodatage, sinon regroupées (stdout puis stderr) comme
 * avant — on n'invente jamais un ordre qu'on ne connaît pas.
 */
function orderNative(outRows, errRows) {
  const all = [...outRows, ...errRows];
  if (all.length && all.every((r) => r.at !== null)) {
    return all
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
      .map(({ r }) => r);
  }
  return all;
}

/**
 * @param {object} p
 * @param {string[]} p.outLines  - dernières lignes du fichier natif stdout
 * @param {string[]} p.errLines  - dernières lignes du fichier natif stderr
 * @param {{t:number,type:string,text:string}[]} p.storeRows - fin du LogStore, ordre chronologique
 * @param {number} p.limit       - nombre maximum de lignes renvoyées (hors source "native", voir ci-dessous)
 * @returns {{ results: {type:"out"|"err", text:string, at:number|null}[], source: "store"|"native" }}
 */
function buildBacklog({ outLines, errLines, storeRows, limit }) {
  const outRows = toNativeRows("out", outLines);
  const errRows = toNativeRows("err", errLines);
  const store = (storeRows || []).map((row) => ({
    type: row.type === "err" ? "err" : "out",
    text: row.text,
    at: row.t,
  }));

  if (!store.length) {
    // Aucune donnée horodatée : on retombe sur les fichiers natifs seuls.
    // `limit` s'applique par flux (comportement historique de cette route).
    return { results: orderNative(outRows, errRows), source: "native" };
  }

  const storeOut = store.filter((r) => r.type === "out").map((r) => r.text);
  const storeErr = store.filter((r) => r.type === "err").map((r) => r.text);
  const older = orderNative(olderNativeLines(outRows, storeOut), olderNativeLines(errRows, storeErr));

  const results = [...older, ...store];
  return { results: results.slice(-Math.max(1, limit)), source: "store" };
}

module.exports = { buildBacklog, splitNativeTimestamp, olderNativeLines };
