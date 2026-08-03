// pdf-parse's package index runs a `module.parent` debug check that crashes
// when the CJS module is loaded via ESM `import` (module.parent is undefined
// there), so the code imports the library file directly. @types/pdf-parse
// only declares the package root; mirror it for the subpath.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse from "pdf-parse";
  export default pdfParse;
}
