export type CodeLanguage = 'javascript' | 'python' | 'bash' | 'json' | 'typescript' | 'css' | 'html' | 'unknown';

const LANGUAGE_HINTS: Array<[CodeLanguage, RegExp]> = [
  ['json', /^\s*(?:[\[{]|\{\s*["'])/],
  ['python', /(^|\n)\s*(def |class |from |import |if __name__|#!\/.*python)|\b(print|None|True|False)\b/],
  ['bash', /(^|\n)\s*(#!.*\b(ba)?sh\b|\$\s+|export [A-Z_]+|if \[|for \w+ in |echo )/],
  ['typescript', /\b(interface|type)\s+\w+|:\s*(string|number|boolean|unknown)(\s*[;,=])/],
  ['javascript', /(^|\n)\s*(import |export |const |let |var |function |async |class )|=>|console\.log\s*\(/],
  ['css', /(^|\n)\s*[.#][\w-]+\s*\{[\s\S]*\}/],
  ['html', /<(!DOCTYPE|[a-z][^>]*>)/i],
];

export function detectCodeLanguage(code: string): CodeLanguage {
  const trimmed = code.trim();
  return LANGUAGE_HINTS.find(([, pattern]) => pattern.test(trimmed))?.[0] ?? 'unknown';
}

/** Normalize clipboard text while preserving meaningful indentation. */
export function normalizePastedCode(code: string): string {
  const lines = code
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
    .split('\n');

  // Clipboard sources often wrap the entire snippet in an extra indentation
  // level. Remove only the common prefix; relative indentation remains intact.
  const indented = lines.filter((line) => line.trim().length > 0);
  const commonIndent = indented.reduce((min, line) => {
    const width = line.match(/^[ \t]*/)?.[0].length ?? 0;
    return Math.min(min, width);
  }, Number.POSITIVE_INFINITY);
  const prefix = Number.isFinite(commonIndent) ? commonIndent : 0;

  return lines.map((line) => line.slice(prefix)).join('\n');
}

export function codeLanguageClass(language: CodeLanguage): string {
  return language === 'unknown' ? 'language-plain' : `language-${language}`;
}
