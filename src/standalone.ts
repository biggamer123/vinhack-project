/**
 * Blast Radius - standalone (browser) build of the graph page.
 *
 * Takes the same media/graph.html the webview uses and bakes the data into it so
 * it runs from a file:// URL with no extension host behind it.
 *
 * Dependency-free so scripts/check-webview.js can verify the produced page
 * actually boots - the ordering here is load-bearing, see buildStandaloneHtml.
 */

export interface StandalonePayload {
  type: "graph";
  nodes: unknown[];
  edges: unknown[];
  summary: string;
}

export function buildStandaloneHtml(
  template: string,
  payload: StandalonePayload,
  stamp: string,
): string {
  const data = JSON.stringify({
    ...payload,
    standalone: true,
    summary: `${payload.summary} · snapshot ${stamp}`,
  });

  // The stub MUST be injected before the page's own script: that script calls
  // acquireVsCodeApi() on its first line, and outside a webview the call would
  // throw and take the whole page down with it (blank canvas, stuck on
  // "booting dex…"). Anchor on the d3 <script> tag, which precedes it.
  const D3_TAG = /<script [^>]*src="https:\/\/cdnjs[^"]*"[^>]*><\/script>/;
  if (!D3_TAG.test(template)) {
    throw new Error(
      "graph.html: could not find the d3 script tag to inject before",
    );
  }

  const bootstrap = `<script nonce="standalone">
      // No extension host here: swallow the messages the page would post back.
      window.acquireVsCodeApi = () => ({ postMessage: () => {} });
      window.__blastRadiusData = ${data};
      window.addEventListener('load', () => setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', { data: window.__blastRadiusData }));
      }, 60));
    </script>\n`;

  return (
    template
      // The CSP meta targets the webview sandbox; a file:// page needs its own rules.
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
      .replace(/\{\{nonce\}\}/g, "standalone")
      .replace(/\{\{cspSource\}\}/g, "")
      .replace(D3_TAG, (tag) => bootstrap + tag)
  );
}
