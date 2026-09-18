export interface TestReference {
  file: string;
  line: number;
  name: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TEST_START = /\b(?:it|test|specify)\s*\(\s*['"`]([^'"`]+)['"`]/;
const WINDOW = 35;

/**
 * The lines belonging to the test that starts at `start`: up to the next test
 * declaration, capped at WINDOW lines. Without the stop, a short test would
 * swallow the one after it and get credited with that test's functions.
 */
function testBlock(lines: string[], start: number): string {
  const end = Math.min(lines.length, start + WINDOW);
  const body = [lines[start]];
  for (let i = start + 1; i < end; i++) {
    if (TEST_START.test(lines[i])) {
      break;
    }
    body.push(lines[i]);
  }
  return body.join("\n");
}

export function findTestReferences(text: string, targetName: string): TestReference[] {
  const refs: TestReference[] = [];
  const lines = text.split(/\r?\n/);
  const target = new RegExp(`\\b${escapeRegex(targetName)}\\b`);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const testMatch = line.match(TEST_START);
    if (!testMatch) {
      continue;
    }
    const block = testBlock(lines, index);
    if (!target.test(block)) {
      continue;
    }
    refs.push({
      file: "",
      line: index,
      name: testMatch[1].trim(),
    });
  }

  return refs;
}

export function extractTestIdentifiers(text: string): Map<string, TestReference[]> {
  const byName = new Map<string, TestReference[]>();
  const lines = text.split(/\r?\n/);

  for (let start = 0; start < lines.length; start++) {
    const line = lines[start];
    const titleMatch = line.match(TEST_START);
    if (!titleMatch) {
      continue;
    }

    const block = testBlock(lines, start);
    const names = new Set<string>();
    for (const match of block.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      const name = match[0];
      if (/^(?:it|test|specify|describe|expect|beforeEach|afterEach|beforeAll|afterAll|await|async|return|const|let|var|if|else|for|while|switch|case|new|throw|try|catch|finally|class|function|export|import|from|true|false|null|undefined|typeof|instanceof|console|Promise|Object|Array|Math|Number|String|Boolean|Date|JSON|require)$/.test(name)) {
        continue;
      }
      names.add(name);
    }

    for (const name of names) {
      const list = byName.get(name) || [];
      list.push({ file: "", line: start, name: titleMatch[1].trim() });
      byName.set(name, list);
    }
  }

  return byName;
}
