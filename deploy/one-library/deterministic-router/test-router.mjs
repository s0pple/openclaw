import assert from "node:assert/strict";
import { route } from "./router.js";

const cases = [
  ["Wo bin ich bei Shadow Slave?", "local"],
  ["Wie viele Titel sind in meiner OneLibrary?", "local"],
  ["Welche Capture-Aktivität gibt es für Murim Login?", "local"],
  ["Was habe ich zuletzt gelesen, und bei welchen Titeln fehlt ein bestätigter Ausgangsstand?", "high"],
  ["Erstelle einen Plan für dieses Repository", "high"],
  ["Lösche die Datei mit sudo", "high"],
  ["Was ist SQLite?", "local"],
  ["/deep Erkläre das", "high"],
  ["/fast kurz antworten", "local"]
];

for (const [prompt, expected] of cases) assert.equal(route(prompt), expected, prompt);
console.log(`${cases.length} routing checks passed`);
