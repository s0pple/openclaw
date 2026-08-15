const library = /\b(onelibrary|shadow slave|murim login|titel|kapitel|baseline|ausgangsstand|quelle[n]?|capture[- ]?event|lese(?:fortschritt|aktivität)|progress)\b/i;
const recent = /\b(zuletzt|letzte[nrsm]?|recent|historisch|aktivität)\b/i;
const missing = /\b(fehl|ohne|baseline|ausgangsstand)\w*/i;
const high = /\b(analys|vergleich|erklär|begründe|plane?|strategie|komplex|mehrstufig|architektur|review|prüfe gründlich|recherch|sudo|lösch|delete|force|reset|credential|secret|passwort|zahlung|trade|veröffentlich|public|deploy|repository|repo|code|test|datei|mac|terminal)\w*/i;

export function route(prompt) {
  const text = String(prompt || "").trim();
  if (/^\/(fast|local)\b/i.test(text)) return "local";
  if (/^\/(deep|pc|code)\b/i.test(text)) return "high";
  if (library.test(text)) return recent.test(text) && missing.test(text) ? "high" : "local";
  if (high.test(text) || text.length > 280) return "high";
  return "local";
}
