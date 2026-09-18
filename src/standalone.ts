/**
 * Blast Radius - standalone (browser) build of the graph page.
 *
 * Takes the same media/graph.html the webview uses and bakes the data into it so
 * it runs from a file:// URL with no extension host behind it.
 *
 * Dependency-free so scripts/check-webview.js can verify the produced page
 * actually boots - the injection point here is load-bearing, see below.
 */

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
  const data = JSON.stringify({
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
