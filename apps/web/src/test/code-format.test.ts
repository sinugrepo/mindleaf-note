import { describe, expect, it } from 'vitest';
import { codeLanguageClass, detectCodeLanguage, normalizePastedCode } from '../lib/code-format';

describe('code paste formatting', () => {
  it.each([
    ['javascript', 'const greet = (name) => console.log(name);'],
    ['python', 'def greet(name):\n    print(name)'],
    ['bash', '#!/usr/bin/env bash\necho "hello"'],
  ] as const)('detects %s', (language, source) => {
    expect(detectCodeLanguage(source)).toBe(language);
    expect(codeLanguageClass(language)).toBe(`language-${language}`);
  });

  it('normalizes clipboard line endings and removes accidental trailing whitespace', () => {
    expect(normalizePastedCode('\r\n  const x = 1;  \r\n\r\n')).toBe('const x = 1;');
  });

  it('removes only a shared wrapper indentation and preserves relative indentation', () => {
    expect(normalizePastedCode('    def main():\n        print("ok")')).toBe(
      'def main():\n    print("ok")',
    );
  });
});
