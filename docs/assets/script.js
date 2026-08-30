"use strict";

/**
 * docs/assets/script.js — landing page pm2-monitor.
 * Vanilla JS, zéro dépendance : cohérent avec l'esprit "self-hosted, pas de
 * build step" du projet lui-même pour une simple page statique.
 */

const REPO = "nogebeat/pm2-monitor";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------------- */
/* Nav mobile                                                              */
/* ---------------------------------------------------------------------- */
(function initNav() {
  const nav = document.querySelector(".nav");
  const toggle = document.querySelector(".nav-toggle");
  if (!nav || !toggle) return;

  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  nav.querySelectorAll(".nav-links a").forEach((a) => {
    a.addEventListener("click", () => nav.classList.remove("is-open"));
  });
})();

/* ---------------------------------------------------------------------- */
/* Copier les commandes d'install                                          */
/* ---------------------------------------------------------------------- */
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const text = btn.getAttribute("data-copy");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Presse-papiers indisponible (contexte non sécurisé, permission
      // refusée…) : on tente un fallback plutôt que de ne rien faire.
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      try {
        document.execCommand("copy");
      } catch (e2) {
        /* tant pis : bouton simplement inerte */
      }
      document.body.removeChild(helper);
    }
    btn.classList.add("copied");
    clearTimeout(btn._resetTimer);
    btn._resetTimer = setTimeout(() => btn.classList.remove("copied"), 1600);
  });
});

/* ---------------------------------------------------------------------- */
/* Compteur d'étoiles GitHub (API publique, sans auth)                     */
/* ---------------------------------------------------------------------- */
(function loadStarCount() {
  const els = document.querySelectorAll("[data-star-count]");
  if (!els.length) return;
  fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      if (typeof data.stargazers_count !== "number") return;
      const formatted =
        data.stargazers_count >= 1000
          ? (data.stargazers_count / 1000).toFixed(1).replace(/\.0$/, "") + "k"
          : String(data.stargazers_count);
      els.forEach((el) => {
        el.textContent = formatted;
        el.hidden = false;
      });
    })
    .catch(() => {
      /* Hors ligne / rate-limit / repo privé sur ce miroir local : le
         bouton "Star" reste utile sans le chiffre, pas d'erreur affichée. */
    });
})();

/* ---------------------------------------------------------------------- */
/* Mockup héro : process list + flux de logs qui "tourne" en continu       */
/* ---------------------------------------------------------------------- */
(function runMockup() {
  const feed = document.getElementById("mockup-log-feed");
  if (!feed) return;

  const LINES = [
    { type: "out", t: "12:04:31", html: 'GET <span class="hl">/api/orders</span> 200 in 41ms' },
    { type: "out", t: "12:04:31", html: "worker ready — pid 41922" },
    { type: "err", t: "12:04:33", html: 'connect ECONNREFUSED <span class="hl">redis:6379</span>' },
    { type: "out", t: "12:04:34", html: "retry 1/5 in 500ms…" },
    { type: "out", t: "12:04:34", html: "redis connecté" },
    { type: "out", t: "12:04:36", html: 'job <span class="hl">send-invoice#8841</span> traité' },
    { type: "out", t: "12:04:38", html: "healthcheck / → 200 OK" },
    { type: "err", t: "12:04:41", html: 'timeout <span class="hl">payments-api</span> (3000ms)' },
    { type: "out", t: "12:04:41", html: "restart programmé (auto-healing)" },
    { type: "out", t: "12:04:44", html: "api-payments en ligne — pid 42017" },
  ];

  const MAX_VISIBLE = 8;
  let i = 0;

  function pushLine() {
    const data = LINES[i % LINES.length];
    i++;

    const row = document.createElement("div");
    row.className = "log-line";
    row.innerHTML =
      `<span class="t">${data.t}</span>` +
      `<span class="tag ${data.type}">${data.type}</span>` +
      `<span class="msg">${data.html}</span>`;
    feed.appendChild(row);

    while (feed.children.length > MAX_VISIBLE) {
      feed.removeChild(feed.firstElementChild);
    }
  }

  // quelques lignes tout de suite pour ne pas partir d'un panneau vide
  for (let n = 0; n < 5; n++) pushLine();

  if (reduceMotion) return; // pas de boucle infinie si l'utilisateur préfère moins de mouvement

  setInterval(pushLine, 1900);

  // petite rotation du process "actif" dans la colonne de gauche
  const rows = document.querySelectorAll(".mockup-procs .proc-row");
  if (rows.length) {
    let active = 0;
    setInterval(() => {
      rows[active].classList.remove("active");
      active = (active + 1) % rows.length;
      rows[active].classList.add("active");
    }, 3400);
  }
})();

/* ---------------------------------------------------------------------- */
/* Reveal au scroll                                                        */
/* ---------------------------------------------------------------------- */
(function initReveal() {
  const targets = document.querySelectorAll("[data-reveal]");
  if (!targets.length) return;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );

  targets.forEach((el, idx) => {
    el.style.transitionDelay = `${Math.min(idx % 3, 2) * 70}ms`;
    io.observe(el);
  });
})();

/* ---------------------------------------------------------------------- */
/* Année du footer                                                         */
/* ---------------------------------------------------------------------- */
(function stampYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = String(new Date().getFullYear());
})();
