/**
 * Blast Radius - one identity per person across their git emails.
 *
 * Merging a PR on GitHub records the commit under
 * `12345+login@users.noreply.github.com`, so the same person shows up twice with
 * two emails. Emails are grouped when they share an author name (case and spacing
 * ignored) or a GitHub login, and every commit is reported under the group's main
 * email - a real address over a noreply one, then the most used. `%aN`/`%aE` also
 * apply the repo's .mailmap, if it has one.
 */
import { execFile } from "child_process";

export interface Identity {
  name: string;
  email: string;
}

const US = String.fromCharCode(31);
const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** GitHub login from a noreply address, or undefined. */
export function githubLogin(email: string): string | undefined {
  const m = NOREPLY.exec(email.trim());
  return m ? m[1].toLowerCase() : undefined;
}

/** Group `name, email, commits` rows into people; returns email -> canonical identity. */
export function buildIdentities(rows: { name: string; email: string; count: number }[]): Map<string, Identity> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    for (const k of [a, b]) {
      if (!parent.has(k)) {
        parent.set(k, k);
      }
    }
    parent.set(find(a), find(b));
  };

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    const key = `e:${email}`;
    if (!parent.has(key)) {
      parent.set(key, key);
    }
    if (row.name.trim()) {
      union(key, `n:${nameKey(row.name)}`);
    }
    const login = githubLogin(email);
    if (login) {
      union(key, `n:${login}`);
    }
  }

  // Pick the main email and name of every group.
  const groups = new Map<string, { emails: Map<string, number>; names: Map<string, number> }>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    const root = find(`e:${email}`);
    const g = groups.get(root) || { emails: new Map(), names: new Map() };
    g.emails.set(email, (g.emails.get(email) || 0) + row.count);
    if (row.name.trim()) {
      g.names.set(row.name.trim(), (g.names.get(row.name.trim()) || 0) + row.count);
    }
    groups.set(root, g);
  }

  const out = new Map<string, Identity>();
  for (const g of groups.values()) {
    const best = (m: Map<string, number>, prefer: (k: string) => boolean = () => true) =>
      [...m.entries()].sort((a, b) => Number(prefer(b[0])) - Number(prefer(a[0])) || b[1] - a[1])[0]?.[0] || "";
    const email = best(g.emails, (e) => !githubLogin(e));
    const name = best(g.names);
    for (const e of g.emails.keys()) {
      out.set(e, { name, email });
    }
  }
  return out;
}

export interface IdentityResolver {
  resolve(name: string, email: string): Identity;
}

const cache = new Map<string, { at: number; resolver: Promise<IdentityResolver> }>();
const TTL_MS = 60_000;

/** A resolver for this repo, built from every author in its history (cached briefly). */
export function identitiesFor(repoRoot: string): Promise<IdentityResolver> {
  const hit = cache.get(repoRoot);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.resolver;
  }
  const resolver = new Promise<IdentityResolver>((resolve) => {
    execFile(
      "git",
      ["log", "--all", "--no-color", `--format=%aN${US}%aE`],
      { cwd: repoRoot, timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        const counts = new Map<string, { name: string; email: string; count: number }>();
        if (!err) {
          for (const line of stdout.split(/\r?\n/)) {
            const [name, email] = line.split(US);
            if (!email) {
              continue;
            }
            const k = `${name}${US}${email}`;
            const row = counts.get(k) || { name, email, count: 0 };
            row.count++;
            counts.set(k, row);
          }
        }
        const map = buildIdentities([...counts.values()]);
        resolve({
          resolve(name: string, email: string): Identity {
            return map.get(email.trim().toLowerCase()) || { name, email };
          },
        });
      },
    );
  });
  cache.set(repoRoot, { at: Date.now(), resolver });
  return resolver;
}
