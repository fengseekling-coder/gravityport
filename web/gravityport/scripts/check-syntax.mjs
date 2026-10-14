import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import ts from "../../../node_modules/typescript/lib/typescript.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "src/App.tsx", "src/ColumnControl.tsx", "src/Icon.tsx",
  "src/ImageViewer.tsx", "src/ToolbarSelect.tsx", "src/i18n.ts",
  "src/main.tsx", "src/mosa-api.ts", "vite.config.ts",
];
let errors = 0;
for (const file of files) {
  const text = readFileSync(resolve(root, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const diagnostic of sf.parseDiagnostics) {
    errors += 1;
    console.error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
}
if (errors) process.exitCode = 1;
else console.log(`Syntax PASS: ${files.length} TypeScript / TSX files`);
