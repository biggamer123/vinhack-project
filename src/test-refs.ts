export interface TestReference {
  file: string;
  line: number;
  name: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTestReferences(text: string, targetName: string): TestReference[] {
  const refs: TestReference[] = [];
  const lines = text.split(/\r?\n/);
  const target = new RegExp(`\\b${escapeRegex(targetName)}\\b`);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const testMatch = line.match(/\b(?:it|test|specify)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (!testMatch) {
      continue;
    }
    const block = lines.slice(index, Math.min(lines.length, index + 35)).join("\n");
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
    const titleMatch = line.match(/\b(?:it|test|specify)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (!titleMatch) {
      continue;
    }

    const block = lines.slice(start, Math.min(lines.length, start + 35)).join("\n");
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
