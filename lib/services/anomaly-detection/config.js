"use strict";

/**
 * Constantes et valeurs par défaut de la détection d'anomalies (Phase 16).
 * Même rôle que lib/services/process-history/config.js ou
 * lib/services/events/config.js : un seul endroit pour les valeurs
 * réglables, lues depuis l'environnement avec un défaut sûr.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Métriques valides par type de cible — même idée que
// lib/services/alerts/alert-rules-store.js#METRICS_BY_TARGET_TYPE, restreint
// aux métriques pour lesquelles on dispose d'un historique exploitable :
//  - cpu/memory : lues en direct (collector.js) + baseline depuis
//    l'historique déjà collecté (lib/history-store.js pour system,
//    lib/services/process-history/ pour process) — aucune nouvelle collecte.
//  - restart_rate/crash_rate/event_rate : dérivées de la timeline
//    d'événements existante (lib/services/events/), pas de nouveau compteur.
const METRICS_BY_TARGET_TYPE = {
  system: ["cpu", "memory", "disk"],
  process: ["cpu", "memory", "restart_rate", "crash_rate", "event_rate"],
};

// Métriques dérivées d'un comptage d'événements sur des fenêtres ("buckets")
// successives, par opposition aux métriques numériques cpu/memory/disk lues
// directement dans un historique de valeurs. Utilisé par readers.js pour
// choisir la bonne stratégie de lecture.
const COUNT_METRICS = ["restart_rate", "crash_rate", "event_rate"];

// Table de mapping metric -> type(s) d'événement process_events concernés
// (lib/services/events/normalizer.js#EVENT_TYPES). event_rate = tout type.
const EVENT_TYPES_BY_METRIC = {
  restart_rate: ["restarted"],
  crash_rate: ["crashed", "errored"],
  event_rate: null, // null = tous types
};

const DEFAULTS = {
  // Nombre d'écarts-types (z-score) à partir duquel une valeur est jugée
  // anormale. 3.0 = ~99.7% des valeurs "normales" d'une distribution à peu
  // près gaussienne restent en-deçà — seuil standard, volontairement
  // conservateur pour limiter les faux positifs.
  sensitivity: 3,
  // Fenêtre historique utilisée pour calculer la baseline (moyenne/écart-type).
  windowMs: DAY_MS,
  // Nombre minimum d'échantillons dans la fenêtre pour oser calculer une
  // baseline. En-dessous, on considère les données insuffisantes et on
  // n'évalue PAS (jamais de faux positif "par manque de données").
  minSamples: 10,
  // Anti-flapping : même mécanisme que alert_rules.cooldown_seconds
  // (lib/services/alerts/engine.js), réutilisé tel quel via la règle
  // virtuelle construite par service.js.
  cooldownSeconds: 900,
  severity: "warning",
};

// Taille d'un "bucket" pour les métriques de comptage (restart_rate/
// crash_rate/event_rate) : le nombre d'événements est compté par tranche
// d'1h, la fenêtre historique détermine combien de tranches passées servent
// de baseline. Pas exposé en configuration (la tâche ne demande que
// activation/sensibilité/fenêtre/métriques/cooldown) : une valeur fixe et
// documentée est plus simple à comprendre qu'un réglage de plus.
const COUNT_METRIC_BUCKET_MS = HOUR_MS;

// Borne dure sur le nombre de buckets interrogés par évaluation (une requête
// COUNT par bucket) : évite qu'une fenêtre historique mal configurée
// (ex: 365 jours) ne déclenche des centaines de requêtes à chaque tick.
const MAX_COUNT_BUCKETS = 200;

module.exports = {
  HOUR_MS,
  DAY_MS,
  METRICS_BY_TARGET_TYPE,
  COUNT_METRICS,
  EVENT_TYPES_BY_METRIC,
  DEFAULTS,
  COUNT_METRIC_BUCKET_MS,
  MAX_COUNT_BUCKETS,
};
