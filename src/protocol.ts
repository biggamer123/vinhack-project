/**
 * Blast Radius - webview protocol version.
 *
 * The page (media/graph.html) is read fresh from disk every time a panel opens,
 * but the compiled extension host stays in memory for the life of a VS Code
 * window. Installing a new VSIX over a running window therefore pairs a NEW page
 * with an OLD host: the new tabs appear, but fields the new page expects are
 * missing from the payload, so git history and schemas look broken for no
 * visible reason.
 *
 * Bump this whenever the payload gains fields the page relies on. The page
 * compares it against its own copy and tells the user to restart VS Code.
 */
export const PROTOCOL_VERSION = 4;
