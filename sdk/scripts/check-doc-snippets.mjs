/**
 * Typecheck the guide code examples in docs/snippets/ (pulled into the guides
 * with VitePress `<<<` includes) against the SDK's public entry point.
 *
 * tsconfig.docs.json maps `@opaquecash/stellar` to src/index.ts, so an example
 * that calls a helper the package doesn't export fails here instead of shipping
 * in the docs. Only diagnostics in the snippets themselves are reported: this
 * gate is about the examples, and SDK source errors belong to `typecheck`.
 *
 *   node scripts/check-doc-snippets.mjs
 */
import { resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const snippetsDir = resolve(root, "docs/snippets") + sep;

const configPath = resolve(root, "tsconfig.docs.json");
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root, undefined, configPath);

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => d.file && resolve(d.file.fileName).startsWith(snippetsDir));

if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
  console.error(`docs snippets: ${diagnostics.length} error(s)`);
  process.exit(1);
}
console.log(`docs snippets: ${parsed.fileNames.length} file(s) typecheck`);
