/**
 * Blast Radius - standalone (browser) build of the graph page.
 *
 * Takes the same media/graph.html the webview uses and bakes the data into it so
 * it runs from a file:// URL with no extension host behind it.
 *
 * Dependency-free so scripts/check-webview.js can verify the produced page
 * actually boots - the injection point here is load-bearing, see below.
 */

import * as http from "http";

export interface StandalonePayload {
  type: "graph";
  nodes: unknown[];
  edges: unknown[];
  summary: string;
  /** Everything else the page understands (schema, protocol, version, focus). */
  [key: string]: unknown;
}

export function buildStandaloneHtml(
  template: string,
  payload: StandalonePayload,
  stamp: string
): string {
  const data = jsonForScript({
    ...payload,
    standalone: true,
    summary: `${payload.summary} · snapshot ${stamp}`,
  });

  const bootstrap = `<script nonce="standalone">
      // No extension host here: swallow the messages the page would post back.
      window.acquireVsCodeApi = () => ({ postMessage: () => {} });
      window.__blastRadiusData = ${data};
      window.addEventListener('load', () => setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', { data: window.__blastRadiusData }));
      }, 60));
    </script>
    `;

  // The bootstrap MUST run before the page's own script, which reads
  // window.__blastRadiusData on load and calls acquireVsCodeApi() near the top.
  // Anchor on the FIRST <script> in the document, whatever it happens to be:
  // matching one specific tag is brittle, because a formatter can rewrap its
  // attributes across lines at any time. (One did, and broke this.)
  const firstScript = template.search(/<script\b/i);
  if (firstScript === -1) {
    throw new Error('graph.html: no <script> tag found, cannot inject the standalone bootstrap');
  }

  const injected = template.slice(0, firstScript) + bootstrap + template.slice(firstScript);

  return (
    injected
      // The CSP meta targets the webview sandbox; a file:// page needs its own rules.
      .replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
      .replace(/\{\{nonce\}\}/g, 'standalone')
      .replace(/\{\{cspSource\}\}/g, '')
  );
}

/**
 * Strip CDN <script> tags. Used by the headless checks, which supply their own
 * copy of d3 rather than reaching the network.
 */
export function removeCdnScripts(html: string): string {
  return html.replace(/<script\b[^>]*\bsrc\s*=\s*"https:\/\/[^"]*"[^>]*>\s*<\/script>/gi, '');
}

/**
 * JSON that is safe to place inside an inline <script>.
 *
 * JSON.stringify leaves "<", ">" and "&" alone, so any string containing
 * "</script>" - source code, a commit message, a test name - ends the script
 * block early and the page renders nothing. "<!--" inside a script also changes
 * how the browser parses what follows. Escaping those characters as \u
 * sequences keeps the value identical once parsed, and U+2028/U+2029 are escaped
 * because older JavaScript engines treat them as line breaks inside strings.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/* ------------------------------------------------------------------ serving */


export interface ServedPage {
  url: string;
  close: () => void;
}

const IDLE_CLOSE_MS = 30 * 60 * 1000;
const MAX_LIVE_SERVERS = 5;
const live: ServedPage[] = [];

/**
 * Serve one snapshot page on a random localhost port.
 *
 * The server stays up while the tab is being used - so reloading works - and
 * closes itself after 30 minutes without a request. Opening more snapshots
 * closes the oldest once more than five are live. Only the page and a favicon
 * are served; everything else is a 404, and nothing listens beyond 127.0.0.1.
 */
export function servePage(html: string, idleCloseMs = IDLE_CLOSE_MS): Promise<ServedPage> {
  const body = Buffer.from(html, "utf8");
  return new Promise((resolve, reject) => {
    let idle: NodeJS.Timeout | undefined;
    const server = http.createServer((req, res) => {
      armIdle();
      const url = (req.url || "/").split("?")[0];
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      if (url === "/" || url === "/blast-radius.html") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    const page: ServedPage = {
      url: "",
      close: () => {
        if (idle) {
          clearTimeout(idle);
        }
        server.close();
        server.closeAllConnections?.();
        const at = live.indexOf(page);
        if (at !== -1) {
          live.splice(at, 1);
        }
      },
    };

    function armIdle(): void {
      if (idle) {
        clearTimeout(idle);
      }
      idle = setTimeout(() => page.close(), idleCloseMs);
      idle.unref();
    }

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a local port for the snapshot"));
        return;
      }
      server.unref();
      page.url = `http://127.0.0.1:${address.port}/blast-radius.html`;
      armIdle();
      live.push(page);
      while (live.length > MAX_LIVE_SERVERS) {
        live[0].close();
      }
      resolve(page);
    });
  });
}
