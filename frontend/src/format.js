export function fmtMem(bytes) {
  if (!bytes) return "0 Mo";
  return (bytes / 1024 / 1024).toFixed(1) + " Mo";
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes < 1024) return bytes + " o";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " Ko";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " Mo";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " Go";
}

export function fmtRate(bytesPerSec) {
  return fmtBytes(bytesPerSec) + "/s";
}

export function fmtUptime(ts) {
  if (!ts) return "–";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "j";
}

export function time(ts) {
  if (!ts) return "·····";
  const d = new Date(ts);
  return d.toLocaleTimeString("fr-FR", { hour12: false });
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const ANSI_FG = {
  30: "#5c6570", 31: "#e85d5d", 32: "#4fd68c", 33: "#e0a64f",
  34: "#5fa8d3", 35: "#c17fd6", 36: "#4fc2d6", 37: "#e4e9ea",
  90: "#7c8a8f", 91: "#f0a3a3", 92: "#8fe3b6", 93: "#eec688",
  94: "#8fc4e6", 95: "#d6adea", 96: "#8fdcea", 97: "#ffffff",
};

// Convertit les codes couleur ANSI (déjà échappés en HTML) en <span> stylés.
export function ansiToHtml(escapedText) {
  const ESC = /\x1b\[([0-9;]*)m/g;
  let result = "";
  let openSpan = false;
  let lastIndex = 0;
  let match;

  while ((match = ESC.exec(escapedText)) !== null) {
    result += escapedText.slice(lastIndex, match.index);
    lastIndex = ESC.lastIndex;

    const codes = match[1].split(";").filter(Boolean).map(Number);
    if (!codes.length || codes.includes(0)) {
      if (openSpan) result += "</span>";
      openSpan = false;
      continue;
    }
    const fg = codes.find((c) => ANSI_FG[c]);
    const bold = codes.includes(1);
    if (fg || bold) {
      if (openSpan) result += "</span>";
      const style = [fg ? `color:${ANSI_FG[fg]}` : "", bold ? "font-weight:600" : ""].filter(Boolean).join(";");
      result += `<span style="${style}">`;
      openSpan = true;
    }
  }
  result += escapedText.slice(lastIndex);
  if (openSpan) result += "</span>";
  return result;
}

export function renderLogText(raw, ansiOn) {
  const escaped = escapeHtml(raw).trimEnd();
  return ansiOn ? ansiToHtml(escaped) : escaped;
}
