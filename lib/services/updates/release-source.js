"use strict";

/**
 * lib/services/updates/release-source.js — lecture des releases publiées sur
 * GitHub (GET /repos/{owner}/{repo}/releases), en lecture seule.
 *
 * Contraintes qui expliquent le code :
 *  - l'API GitHub non authentifiée est limitée (60 requêtes/heure/IP) : on
 *    envoie `If-None-Match` avec l'ETag précédent (une réponse 304 ne coûte
 *    rien) et l'appelant (index.js) n'interroge qu'à intervalle long ;
 *  - aucune donnée de l'installation n'est envoyée : User-Agent générique,
 *    SANS la version installée ni l'hôte (confidentialité) ;
 *  - jamais d'exception vers l'appelant : toute erreur devient
 *    `{ ok: false, code }` (réseau coupé, serveur isolé, limite atteinte…) ;
 *  - la réponse est du contenu distant NON FIABLE : taille plafonnée, champs
 *    réduits à une liste blanche, URL validée (http/https uniquement). Le
 *    texte des notes n'est jamais interprété comme du HTML côté interface.
 */

const http = require("node:http");
const https = require("node:https");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;

function safeUrl(value, fallback) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch (e) {
    /* URL invalide : on retombe sur le lien de repli */
  }
  return fallback;
}

/** Réduit un objet release brut de l'API à ce dont l'interface a besoin. */
function slimRelease(raw, fallbackUrl) {
  if (!raw || typeof raw !== "object") return null;
  const tag = typeof raw.tag_name === "string" ? raw.tag_name.slice(0, 64) : "";
  if (!tag) return null;
  return {
    tag,
    name: typeof raw.name === "string" ? raw.name.slice(0, 200) : "",
    draft: raw.draft === true,
    prerelease: raw.prerelease === true,
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
    url: safeUrl(raw.html_url, fallbackUrl),
    body: typeof raw.body === "string" ? raw.body.slice(0, MAX_BODY_CHARS) : "",
  };
}

/**
 * @param {object} options
 * @param {string} options.repo        "owner/name"
 * @param {string} options.apiBaseUrl  ex. https://api.github.com (sans slash final)
 * @returns {Promise<{ok:true, notModified:boolean, etag:string|null, releases:object[]} | {ok:false, code:string, retryAt?:number}>}
 */
function fetchReleases({ repo, apiBaseUrl, etag, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/repos/${repo}/releases?per_page=20`);
    } catch (e) {
      return resolve({ ok: false, code: "bad_config" });
    }
    const transport = url.protocol === "http:" ? http : https;
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "pm2-monitor-update-check",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (etag) headers["If-None-Match"] = etag;

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = transport.request(url, { method: "GET", headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status === 304) {
        res.resume();
        return done({ ok: true, notModified: true, etag: etag || null, releases: [] });
      }
      if (status === 403 || status === 429) {
        res.resume();
        const remaining = res.headers["x-ratelimit-remaining"];
        const reset = Number(res.headers["x-ratelimit-reset"]);
        const rateLimited = status === 429 || remaining === "0";
        return done({
          ok: false,
          code: rateLimited ? "rate_limited" : "http_403",
          retryAt: rateLimited && Number.isFinite(reset) ? reset * 1000 : undefined,
        });
      }
      if (status === 404) {
        res.resume();
        return done({ ok: false, code: "not_found" });
      }
      if (status !== 200) {
        res.resume();
        return done({ ok: false, code: `http_${status}` });
      }

      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          return done({ ok: false, code: "too_large" });
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Array.isArray(parsed)) return done({ ok: false, code: "bad_response" });
          const fallbackUrl = `https://github.com/${repo}/releases`;
          const releases = parsed.map((r) => slimRelease(r, fallbackUrl)).filter(Boolean);
          done({ ok: true, notModified: false, etag: res.headers.etag || null, releases });
        } catch (e) {
          done({ ok: false, code: "bad_response" });
        }
      });
      res.on("error", () => done({ ok: false, code: "network" }));
    });
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, code: "timeout" });
    });
    req.on("error", () => done({ ok: false, code: "network" }));
    req.end();
  });
}

module.exports = { fetchReleases, slimRelease, safeUrl, MAX_BODY_CHARS };
