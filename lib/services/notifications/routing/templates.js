"use strict";

/**
 * Rendu du titre/message d'une notification à partir d'une occurrence
 * d'alerte (lib/services/alerts/alert-store.js#rowToAlert) et, si fourni,
 * du template `{{placeholder}}` d'une notification_route
 * (routing/route-store.js). Aucune connaissance des providers ici — cette
 * fonction ne produit qu'un objet `{ title, message, severity, timestamp }`,
 * la même forme que providers/shared.js#buildTestNotification, que
 * routing/dispatcher.js passe ensuite tel quel à `provider.send()`.
 *
 * IMPORTANT (sécurité) : les seules variables disponibles sont des champs de
 * l'occurrence d'alerte (jamais de secret de provider — ceux-ci ne
 * transitent jamais par ce module, voir provider-store.js). Un placeholder
 * inconnu (`{{n_importe_quoi}}`) est laissé tel quel plutôt que de lancer,
 * pour qu'une faute de frappe dans un template n'empêche jamais l'envoi.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Variables disponibles dans un template, dérivées uniquement de l'alerte + de l'événement de dispatch. */
function buildVariables(alert, event) {
  return {
    ruleName: alert.ruleName || "",
    severity: alert.severity || "",
    metric: alert.metric || "",
    operator: alert.operator || "",
    threshold: alert.threshold !== undefined && alert.threshold !== null ? String(alert.threshold) : "",
    value: alert.value !== undefined && alert.value !== null ? String(alert.value) : "",
    targetType: alert.targetType || "",
    targetValue: alert.targetValue || "system",
    state: alert.state || "",
    event: event === "resolved" ? "resolved" : "triggered",
    alertId: alert.id !== undefined && alert.id !== null ? String(alert.id) : "",
  };
}

function renderString(str, variables) {
  if (typeof str !== "string") return str;
  return str.replace(PLACEHOLDER_RE, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

function defaultTitle(vars) {
  const verb = vars.event === "resolved" ? "résolue" : "déclenchée";
  const severity = vars.severity ? vars.severity.toUpperCase() : "ALERTE";
  return `[${severity}] Alerte ${verb} — ${vars.ruleName || "(règle inconnue)"}`;
}

function defaultMessage(vars) {
  const target = vars.targetType === "process" ? `process "${vars.targetValue}"` : "système";
  const condition = [vars.metric, vars.operator, vars.threshold].filter(Boolean).join(" ");
  const base = condition ? `${condition} sur ${target}` : `Alerte sur ${target}`;
  return vars.value ? `${base} (valeur actuelle : ${vars.value}).` : `${base}.`;
}

/**
 * @param {{titleTemplate?: string|null, messageTemplate?: string|null}|null} route
 * @param {object} alert - occurrence d'alerte (alert-store.js#rowToAlert)
 * @param {"triggered"|"resolved"} event
 */
function renderNotification(route, alert, event) {
  const vars = buildVariables(alert || {}, event);
  const title =
    route && route.titleTemplate ? renderString(route.titleTemplate, vars) : defaultTitle(vars);
  const message =
    route && route.messageTemplate ? renderString(route.messageTemplate, vars) : defaultMessage(vars);
  return {
    title,
    message,
    severity: (alert && alert.severity) || "info",
    timestamp: new Date().toISOString(),
  };
}

module.exports = { buildVariables, renderString, renderNotification, defaultTitle, defaultMessage };
