"use strict";

/**
 * docs/assets/script.js — landing page pm2-monitor.
 * Vanilla JS, zéro dépendance : cohérent avec l'esprit "self-hosted, pas de
 * build step" du projet lui-même pour une simple page statique.
 */

const REPO = "nogebeat/pm2-monitor";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------------- */
/* i18n fr/en                                                              */
/*                                                                          */
/* Site statique sans build : pas de librairie i18n, juste un dictionnaire */
/* plat et quatre attributs (data-i18n, -html, -aria, -alt) posés dans le  */
/* HTML. La langue choisie est mémorisée en localStorage ; à défaut on se  */
/* cale sur la langue du navigateur, avec le français en repli.            */
/* ---------------------------------------------------------------------- */
const I18N = {
  fr: {
    "nav.features": "Fonctionnalités",
    "nav.install": "Installation",
    "nav.logexplorer": "Log Explorer",
    "nav.opensource": "Open source",
    "nav.docs": "Documentation",
    "nav.menuLabel": "Ouvrir le menu",
    "hero.eyebrow": "auto-hébergé · open source · mit",
    "hero.h1": 'Tes process PM2,<br /><span class="accent">en direct</span>.',
    "hero.lede":
      "Statut, CPU/RAM, logs stdout/stderr, alertes, auto-healing, multi-serveur — un seul dashboard qui tourne sur ta machine, pas sur celle de quelqu'un d'autre. Aucun compte à créer, aucun SaaS, juste ton PM2.",
    "cta.github": "Voir sur GitHub",
    "cta.install": "Installation",
    "hero.meta.starsSuffix": " sur GitHub",
    "mockup.online": "3 en ligne",
    "tech.label": "Sous le capot",
    "tech.nobuild": "zéro build à installer côté serveur",
    "features.eyebrow": "fonctionnalités",
    "features.h2": "Tout ce que <code>pm2 monit</code> ne te montre pas.",
    "features.lede":
      "21 phases de développement, un seul dashboard. Chaque brique s'appuie sur le même flux temps réel — pas de système parallèle à maintenir.",
    "feat.processes.title": "Process en un coup d'œil",
    "feat.processes.body":
      "Statut, CPU, mémoire, restarts, uptime, mode fork/cluster. Start / restart / reload / stop en un clic, scale et hot-reload de la config sans passer par le terminal.",
    "feat.logs.title": "Logs en direct, sans latence",
    "feat.logs.body":
      "stdout/stderr streamés par WebSocket, comme <code>pm2 logs</code> mais dans le navigateur. Pause, recherche regex, coloration ANSI, export brut ou par période exacte.",
    "feat.explorer.body":
      "Recherche full-text ou regex à travers plusieurs process <em>et</em> plusieurs serveurs en un seul appel, avec contexte avant/après et export streamé.",
    "feat.dashboard.title": "Dashboard global",
    "feat.dashboard.body":
      "Statut <code>HEALTHY / WARNING / CRITICAL</code> calculé automatiquement : système, process, alertes et timeline d'événements, en un seul coup d'œil au démarrage.",
    "feat.dashboard.pill": "temps réel",
    "feat.alerts.title": "Alertes &amp; health checks",
    "feat.alerts.body":
      "Seuils CPU/RAM/restarts avec cooldown et déduplication, plus des sondes HTTP/TCP/Command indépendantes du statut PM2 pour surveiller ce que PM2 ne voit pas.",
    "feat.autoheal.body":
      "Redémarrage automatique d'un process qui crash en boucle, avec garde-fous configurables et journalisation de chaque intervention. Désactivé par défaut.",
    "feat.multiserver.title": "Multi-serveur",
    "feat.multiserver.body":
      "Connecte plusieurs machines via des agents distants et surveille toute ta flotte PM2 depuis un seul écran — process, logs et recherche compris.",
    "feat.notif.title": "Notifications multi-canal",
    "feat.notif.body":
      "Email, Discord, Telegram, Slack, webhook générique. Routing par règles depuis le moteur d'alertes, avec file d'attente, retry et déduplication.",
    "feat.rbac.title": "RBAC, clés API &amp; audit",
    "feat.rbac.body":
      "Permissions fines par app et par serveur, clés API scopées pour intégrer PM2 Monitor ailleurs, et un journal d'audit append-only de chaque action sensible.",
    "install.eyebrow": "installation",
    "install.h2": "En route en trois commandes.",
    "install.lede":
      "<code>deploy.sh</code> installe Node.js et PM2 si besoin, compile le frontend, configure nginx + HTTPS en option, et fait un rollback automatique si une mise à jour casse tout.",
    "install.step1.tag": "cloner le dépôt",
    "install.step1.title": "Récupère le code",
    "install.step1.body": "Un simple clone Git, aucune inscription ni token requis.",
    "install.step1.comment": "# sur ton serveur",
    "install.step2.tag": "installer &amp; démarrer",
    "install.step2.title": "Un script, toutes les situations",
    "install.step2.body": "Détecte ce qui est déjà en place, ne réinstalle rien inutilement.",
    "install.step2.comment": "# installe, build, démarre sous PM2",
    "install.step3.tag": "ouvrir le dashboard",
    "install.step3.title": "Port 4200 par défaut",
    "install.step3.body": "Accès direct par IP, ou derrière nginx + HTTPS si tu as fourni un domaine.",
    "install.step3.comment": "# identifiants générés à l'install",
    "install.copyCmd": "Copier la commande",
    "install.copyAddr": "Copier l'adresse",
    "explorer.h2": "Retrouve la ligne qui explique l'incident, pas dans dix onglets.",
    "explorer.item1":
      "<b>Recherche unifiée</b> — full-text ou regex, sur un process, plusieurs process, ou plusieurs serveurs en même temps.",
    "explorer.item2":
      "<b>Filtres combinables</b> — niveau (info/warn/error/debug), flux (stdout/stderr), plage de dates précise.",
    "explorer.item3":
      "<b>Contexte automatique</b> — les lignes juste avant/après chaque résultat, sans changer d'écran.",
    "explorer.item4":
      "<b>Garde-fous intégrés</b> — regex bornées et anti-ReDoS, limites de lignes scannées : jamais une requête non bornée.",
    "explorer.allServers": "tous les serveurs",
    "oss.h2": "100% open source, sans surprise.",
    "oss.lede":
      "Licence MIT. Zéro télémétrie, zéro palier payant caché — le code que tu fais tourner est exactement celui du dépôt. Les PR sont les bienvenues.",
    "oss.badge.ci": "Statut CI",
    "oss.badge.mit": "Licence MIT",
    "oss.contribGuide": "Guide de contribution",
    "oss.reportBug": "Signaler un bug",
    "oss.card1.title": "Auto-hébergé, toujours",
    "oss.card1.body":
      "Tes logs et tes métriques ne quittent jamais ta machine. Base SQLite locale par défaut, MySQL/MariaDB en option si tu en as déjà un.",
    "oss.card2.title": "Un script d'install qui fait le travail",
    "oss.card2.body":
      "<code>deploy.sh</code> gère Node.js, PM2, nginx, HTTPS, le pare-feu, et fait un rollback automatique si une mise à jour casse le démarrage.",
    "finalcta.eyebrow": "à toi de jouer",
    "finalcta.h2": "Prêt à voir ce que fait vraiment ton serveur ?",
    "finalcta.lede":
      "Cinq minutes d'installation, un dashboard qui reste à toi. Aucune carte bancaire, aucune limite artificielle.",
    "finalcta.installGuide": "Guide d'installation",
    "footer.brand.body":
      "Dashboard temps réel auto-hébergé pour PM2 — process, logs, alertes, auto-healing, multi-serveur. MIT, par et pour des devs.",
    "footer.product.title": "Produit",
    "footer.product.architecture": "Architecture",
    "footer.product.changelog": "Changelog",
    "footer.docs.title": "Documentation",
    "footer.docs.multiserver": "Multi-serveur",
    "footer.docs.notifications": "Notifications",
    "footer.docs.rbac": "RBAC &amp; clés API",
    "footer.community.title": "Communauté",
    "footer.community.issues": "Issues",
    "footer.community.contribute": "Contribuer",
    "footer.community.license": "Licence MIT",
    "footer.community.security": "Sécurité",
    "footer.copyright": '© <span id="year">2026</span> PM2 Monitor contributors — MIT License',
  },
  en: {
    "nav.features": "Features",
    "nav.install": "Installation",
    "nav.logexplorer": "Log Explorer",
    "nav.opensource": "Open source",
    "nav.docs": "Documentation",
    "nav.menuLabel": "Open menu",
    "hero.eyebrow": "self-hosted · open source · mit",
    "hero.h1": 'Your PM2 processes,<br /><span class="accent">live</span>.',
    "hero.lede":
      "Status, CPU/RAM, stdout/stderr logs, alerts, auto-healing, multi-server — one dashboard running on your machine, not someone else's. No account to create, no SaaS, just your PM2.",
    "cta.github": "View on GitHub",
    "cta.install": "Installation",
    "hero.meta.starsSuffix": " on GitHub",
    "mockup.online": "3 online",
    "tech.label": "Under the hood",
    "tech.nobuild": "zero build step to install on the server",
    "features.eyebrow": "features",
    "features.h2": "Everything <code>pm2 monit</code> doesn't show you.",
    "features.lede":
      "21 development phases, one dashboard. Every piece runs on the same real-time stream — no parallel system to maintain.",
    "feat.processes.title": "Processes at a glance",
    "feat.processes.body":
      "Status, CPU, memory, restarts, uptime, fork/cluster mode. Start / restart / reload / stop in one click, scale and hot-reload config without touching the terminal.",
    "feat.logs.title": "Live logs, no lag",
    "feat.logs.body":
      "stdout/stderr streamed over WebSocket, like <code>pm2 logs</code> but in the browser. Pause, regex search, ANSI coloring, raw export or export by exact time range.",
    "feat.explorer.body":
      "Full-text or regex search across multiple processes <em>and</em> multiple servers in a single call, with before/after context and streamed export.",
    "feat.dashboard.title": "Global dashboard",
    "feat.dashboard.body":
      "Automatically computed <code>HEALTHY / WARNING / CRITICAL</code> status: system, processes, alerts and event timeline, at a glance on startup.",
    "feat.dashboard.pill": "real-time",
    "feat.alerts.title": "Alerts &amp; health checks",
    "feat.alerts.body":
      "CPU/RAM/restart thresholds with cooldown and deduplication, plus HTTP/TCP/Command probes independent of PM2 status to watch what PM2 doesn't see.",
    "feat.autoheal.body":
      "Automatic restart for a process crash-looping, with configurable guard rails and a log of every intervention. Disabled by default.",
    "feat.multiserver.title": "Multi-server",
    "feat.multiserver.body":
      "Connect several machines through remote agents and monitor your whole PM2 fleet from one screen — processes, logs and search included.",
    "feat.notif.title": "Multi-channel notifications",
    "feat.notif.body":
      "Email, Discord, Telegram, Slack, generic webhook. Rule-based routing from the alert engine, with a queue, retries and deduplication.",
    "feat.rbac.title": "RBAC, API keys &amp; audit",
    "feat.rbac.body":
      "Fine-grained permissions per app and per server, scoped API keys to integrate PM2 Monitor elsewhere, and an append-only audit log of every sensitive action.",
    "install.eyebrow": "installation",
    "install.h2": "Up and running in three commands.",
    "install.lede":
      "<code>deploy.sh</code> installs Node.js and PM2 if needed, builds the frontend, optionally sets up nginx + HTTPS, and rolls back automatically if an update breaks startup.",
    "install.step1.tag": "clone the repo",
    "install.step1.title": "Grab the code",
    "install.step1.body": "A plain Git clone, no sign-up or token required.",
    "install.step1.comment": "# on your server",
    "install.step2.tag": "install &amp; start",
    "install.step2.title": "One script, every situation",
    "install.step2.body": "Detects what's already in place, doesn't reinstall anything needlessly.",
    "install.step2.comment": "# installs, builds, starts under PM2",
    "install.step3.tag": "open the dashboard",
    "install.step3.title": "Port 4200 by default",
    "install.step3.body": "Direct access by IP, or behind nginx + HTTPS if you provided a domain.",
    "install.step3.comment": "# credentials generated at install time",
    "install.copyCmd": "Copy the command",
    "install.copyAddr": "Copy the address",
    "explorer.h2": "Find the line that explains the incident, not spread across ten tabs.",
    "explorer.item1":
      "<b>Unified search</b> — full-text or regex, across one process, several processes, or several servers at once.",
    "explorer.item2":
      "<b>Combinable filters</b> — level (info/warn/error/debug), stream (stdout/stderr), exact date range.",
    "explorer.item3":
      "<b>Automatic context</b> — the lines just before/after every result, without switching screens.",
    "explorer.item4":
      "<b>Built-in guard rails</b> — bounded, anti-ReDoS regex and scanned-line limits: never an unbounded query.",
    "explorer.allServers": "all servers",
    "oss.h2": "100% open source, no surprises.",
    "oss.lede":
      "MIT license. Zero telemetry, zero hidden paid tier — the code you run is exactly what's in the repo. PRs welcome.",
    "oss.badge.ci": "CI status",
    "oss.badge.mit": "MIT license",
    "oss.contribGuide": "Contributing guide",
    "oss.reportBug": "Report a bug",
    "oss.card1.title": "Self-hosted, always",
    "oss.card1.body":
      "Your logs and metrics never leave your machine. Local SQLite by default, MySQL/MariaDB optional if you already run one.",
    "oss.card2.title": "An install script that does the job",
    "oss.card2.body":
      "<code>deploy.sh</code> handles Node.js, PM2, nginx, HTTPS, the firewall, and rolls back automatically if an update breaks startup.",
    "finalcta.eyebrow": "your move",
    "finalcta.h2": "Ready to see what your server is actually doing?",
    "finalcta.lede":
      "Five minutes to install, a dashboard that stays yours. No credit card, no artificial limits.",
    "finalcta.installGuide": "Installation guide",
    "footer.brand.body":
      "Self-hosted real-time dashboard for PM2 — processes, logs, alerts, auto-healing, multi-server. MIT, by and for devs.",
    "footer.product.title": "Product",
    "footer.product.architecture": "Architecture",
    "footer.product.changelog": "Changelog",
    "footer.docs.title": "Documentation",
    "footer.docs.multiserver": "Multi-server",
    "footer.docs.notifications": "Notifications",
    "footer.docs.rbac": "RBAC &amp; API keys",
    "footer.community.title": "Community",
    "footer.community.issues": "Issues",
    "footer.community.contribute": "Contribute",
    "footer.community.license": "MIT license",
    "footer.community.security": "Security",
    "footer.copyright": '© <span id="year">2026</span> PM2 Monitor contributors — MIT License',
  },
};

const I18N_STORAGE_KEY = "pm2-monitor-docs-lang";

function detectLang() {
  try {
    const saved = window.localStorage.getItem(I18N_STORAGE_KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch (e) {
    /* localStorage indisponible (navigation privée stricte…) : on retombe sur la détection navigateur */
  }
  return (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";
}

function applyLang(lang) {
  const dict = I18N[lang] || I18N.fr;

  document.documentElement.lang = lang;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (dict[key] !== undefined) el.innerHTML = dict[key];
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria");
    if (dict[key] !== undefined) el.setAttribute("aria-label", dict[key]);
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    const key = el.getAttribute("data-i18n-alt");
    if (dict[key] !== undefined) el.setAttribute("alt", dict[key]);
  });

  document.querySelectorAll("[data-lang-current]").forEach((el) => {
    el.textContent = lang.toUpperCase();
  });
}

(function initI18n() {
  let lang = detectLang();
  applyLang(lang);

  const toggle = document.getElementById("lang-switch");
  if (!toggle) return;

  toggle.addEventListener("click", () => {
    lang = lang === "fr" ? "en" : "fr";
    applyLang(lang);
    try {
      window.localStorage.setItem(I18N_STORAGE_KEY, lang);
    } catch (e) {
      /* pas grave : la langue sera simplement redétectée au prochain chargement */
    }
  });
})();

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
