/**
 * Blast Radius - load media/graph.html with its shared modules inlined.
 *
 * The page is a single HTML file, but some logic must be identical in the page
 * and in tested Node code - the Docker project builder in particular. Those
 * modules are compiled from TypeScript as usual and inlined here, so the page
 * runs exactly the code the checks verify. Every place that reads the page
 * (webview, browser export, preview and test scripts) goes through this.
 *
 * Dependency-free apart from fs/path.
 */
import * as fs from "fs";
import * as path from "path";

const PLACEHOLDER = "/*@@PAGE_MODULES@@*/";

/** Compiled modules exposed to the page, as global name -> file under out/. */
const MODULES: Record<string, string> = {
  BlastDocker: "dockerTemplates.js",
};

export function loadPageTemplate(extensionPath: string): string {
  const html = fs.readFileSync(path.join(extensionPath, "media", "graph.html"), "utf8");
  return injectPageModules(html, extensionPath);
}

export function injectPageModules(html: string, extensionPath: string): string {
  if (!html.includes(PLACEHOLDER)) {
    return html;
  }
  const code = Object.entries(MODULES)
    .map(([global, file]) => {
      const compiled = fs.readFileSync(path.join(extensionPath, "out", file), "utf8");
      // CommonJS output writes to `exports`; give it one and publish the result.
      return `var ${global} = (function () { var exports = {}; var module = { exports: exports };\n${compiled}\nreturn module.exports; })();`;
    })
    .join("\n")
    // An inline script ends at the first "</script", wherever it appears.
    .replace(/<\/script/gi, "<\\/script");
  return html.replace(PLACEHOLDER, () => code);
}
