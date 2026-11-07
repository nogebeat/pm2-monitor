"use strict";

/**
 * lib/services/docker/log-demux.js — Docker Monitoring (Phase 22).
 *
 * Décodage du flux renvoyé par `/containers/:id/logs` (Docker Engine API).
 * Deux formats possibles, selon que le conteneur a été démarré avec un TTY
 * (`Config.Tty`, voir lib/services/docker/index.js) :
 *
 *  - SANS TTY (cas normal) : chaque frame est préfixée d'un en-tête de
 *    8 octets — [type(1 octet) | réservé(3 octets) | taille big-endian
 *    (4 octets)] — qui permet de distinguer stdout (type=1) de
 *    stderr (type=2). C'est le format "multiplexé" documenté par l'API
 *    Docker (nécessaire car stdout/stderr partagent la même connexion HTTP).
 *  - AVEC TTY : aucun en-tête, flux brut — Docker lui-même ne distingue pas
 *    stdout/stderr dans ce mode (le pseudo-terminal les fusionne déjà côté
 *    conteneur), donc tout est rapporté comme "out" ici.
 *
 * Un frame (ou une ligne, en mode TTY) peut être coupée en plein milieu par
 * un chunk réseau : ce module accumule un buffer interne entre deux appels
 * à push() plutôt que de supposer qu'un frame/une ligne arrive toujours
 * d'un seul coup.
 */

const HEADER_LEN = 8;
const STREAM_TYPES = { 1: "out", 2: "err" };

class DockerLogDemuxer {
  /** @param {boolean} tty - Config.Tty du conteneur inspecté (voir index.js#inspectContainer) */
  constructor(tty) {
    this.tty = !!tty;
    this._buf = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {{type: "out"|"err", text: string}[]} lignes complètes décodées (peut être vide)
   */
  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    return this.tty ? this._drainTty() : this._drainFramed();
  }

  _drainTty() {
    // Pas d'en-tête : on découpe simplement sur les retours à la ligne, même
    // convention que lib/log-store.js#appendPacket pour les logs PM2 (une
    // ligne vide est ignorée, la dernière ligne incomplète reste en attente
    // du prochain chunk plutôt que d'être rapportée tronquée).
    const text = this._buf.toString("utf8");
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak === -1) return [];
    const complete = text.slice(0, lastBreak);
    this._buf = Buffer.from(text.slice(lastBreak + 1), "utf8");
    return complete
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((text2) => ({ type: "out", text: text2 }));
  }

  _drainFramed() {
    const out = [];
    // Une frame peut elle-même contenir plusieurs lignes ; on les redécoupe
    // après démultiplexage, jamais avant (l'en-tête ne porte que sur la frame,
    // pas sur une ligne).
    for (;;) {
      if (this._buf.length < HEADER_LEN) break;
      const streamType = STREAM_TYPES[this._buf.readUInt8(0)] || "out";
      const size = this._buf.readUInt32BE(4);
      if (this._buf.length < HEADER_LEN + size) break; // frame incomplète : on attend le prochain chunk
      const payload = this._buf.slice(HEADER_LEN, HEADER_LEN + size).toString("utf8");
      this._buf = this._buf.slice(HEADER_LEN + size);
      payload
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .forEach((text) => out.push({ type: streamType, text }));
    }
    return out;
  }
}

// RFC3339Nano (ex: "2026-01-02T15:04:05.123456789Z"), format produit par
// Docker quand `timestamps=1` est demandé sur /logs.
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/;

/** Sépare un préfixe timestamp Docker (`timestamps=1`) d'une ligne, si présent. */
function splitTimestamp(line) {
  const m = TIMESTAMP_RE.exec(line);
  if (!m) return { at: null, text: line };
  const at = Date.parse(m[1]);
  return { at: Number.isFinite(at) ? at : null, text: m[2] };
}

module.exports = { DockerLogDemuxer, splitTimestamp };
