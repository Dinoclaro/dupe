import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface SpellToken {
  word: string;
  startOffset: number;
  endOffset: number;
}

const BUILTIN_ACADEMIC_WORDS = [
  'ablation',
  'ablations',
  'actuation',
  'aleatoric',
  'arxiv',
  'autoregressive',
  'backpropagation',
  'baselined',
  'baselining',
  'benchmarking',
  'bibtex',
  'composable',
  'convolutional',
  'dataset',
  'datasets',
  'denoising',
  'differentiable',
  'discretized',
  'dupe',
  'electrohydraulic',
  'embodied',
  'embeddings',
  'epistemic',
  'equivariant',
  'finetuned',
  'finetuning',
  'generalizability',
  'github',
  'huggingface',
  'hyperparameter',
  'hyperparameters',
  'invariance',
  'invariances',
  'jacobian',
  'kinematics',
  'latent',
  'latents',
  'latex',
  'linearized',
  'locomotion',
  'lossless',
  'markov',
  'markdown',
  'metadata',
  'mini-batch',
  'minibatch',
  'multimodal',
  'multistep',
  'musculoskeletal',
  'nonparametric',
  'offline',
  'online',
  'overfit',
  'overfitting',
  'overleaf',
  'parameterized',
  'pareto',
  'pretrain',
  'pretrained',
  'pretraining',
  'proprioception',
  'proprioceptive',
  'quantized',
  'reparameterize',
  'reparameterization',
  'replay',
  'rollout',
  'rollouts',
  'scalable',
  'scalability',
  'softplus',
  'softmax',
  'sparsity',
  'stateful',
  'suboptimal',
  'suboptimality',
  'subproblem',
  'synctex',
  'teleoperation',
  'timestep',
  'timesteps',
  'tokenizer',
  'tokenizers',
  'tractable',
  'uncertainties',
  'underfit',
  'underfitting',
  'unnormalized',
  'unrolled',
  'unsupervised',
  'visuomotor',
  'wandb',
  'workaround',
  'workflow',
  'workflows',
];

function blankMatching(buf: string[], text: string, regex: RegExp): void {
  if (!regex.global) {
    const m = regex.exec(text);
    if (m) {
      for (let i = m.index; i < m.index + m[0].length; i++) {
        if (buf[i] !== '\n') {
          buf[i] = ' ';
        }
      }
    }
    return;
  }
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    for (let i = start; i < end; i++) {
      if (buf[i] !== '\n') {
        buf[i] = ' ';
      }
    }
    if (m[0].length === 0) {
      regex.lastIndex++;
    }
  }
}

export function maskNonProse(text: string, languageId: string): string {
  const buf = text.split('');

  if (languageId === 'latex' || languageId === 'tex') {
    // Line comments (keep line structure)
    blankMatching(buf, text, /(^|[^\\])%[^\n]*/g);
    // Math & verbatim environments
    blankMatching(
      buf,
      text,
      /\\begin\{(equation\*?|align\*?|gather\*?|eqnarray\*?|multline\*?|verbatim|lstlisting|minted|tikzpicture)\}[\s\S]*?\\end\{\1\}/g,
    );
    // Display & inline math
    blankMatching(buf, text, /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+\$|\\\([^)\n]*\\\)/g);
    // LaTeX macros whose brace argument is an identifier, path, label, or citation key
    blankMatching(
      buf,
      text,
      /\\(?:cite[a-zA-Z*]*|nocite|bibentry|bstctlcite|ref|eqref|pageref|autoref|cref|Cref|label|usepackage|documentclass|bibliographystyle|bibliography|input|include|includegraphics|url|lstset|definecolor|colorlet|newcommand|renewcommand|newenvironment|newlength|setlength|hspace\*?|vspace\*?)\b(?:\s*\[[^\]]*\])?\s*\{[^}]*\}/g,
    );
    // First argument of \href{url}{visible text}
    blankMatching(buf, text, /\\href\s*\{[^}]*\}/g);
    // Optional bracket arguments & macro command names (keeping braced prose like \textbf{...})
    blankMatching(buf, text, /\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])?/g);
  } else if (languageId === 'markdown') {
    // Frontmatter
    blankMatching(buf, text, /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    // Fenced code blocks & inline code
    blankMatching(buf, text, /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g);
    // HTML comments & tags
    blankMatching(buf, text, /<!--[\s\S]*?-->|<[^>]+>/g);
    // Wikilinks: blank target [[note|alias]] up to pipe, or entire [[paper:key]]
    const wikiRe = /(!?)\[\[([^\]\n]+)\]\]/g;
    let wm: RegExpExecArray | null;
    while ((wm = wikiRe.exec(text)) !== null) {
      const pipeRel = wm[2].indexOf('|');
      const endBlank = pipeRel >= 0 ? wm.index + wm[1].length + 2 + pipeRel + 1 : wm.index + wm[0].length;
      for (let i = wm.index; i < endBlank; i++) {
        if (buf[i] !== '\n') {
          buf[i] = ' ';
        }
      }
    }
    // Markdown link targets ](url) and bare URLs
    blankMatching(buf, text, /\]\([^)\n]+\)|https?:\/\/[^\s)>\]]+/g);
    // Hashtags
    blankMatching(buf, text, /(?:^|(?<=[\s,(]))#[a-zA-Z][a-zA-Z0-9_/-]*/g);
  }

  return buf.join('');
}

function shouldSkipToken(raw: string): boolean {
  if (raw.length < 3) {
    return true;
  }
  if (raw === raw.toUpperCase()) {
    return true;
  }
  // Skip camelCase / PascalCase code identifiers like offlineMbrl or DupeServer
  if (/[a-z][A-Z]/.test(raw)) {
    return true;
  }
  return false;
}

export function extractSpellableWords(text: string, languageId: string): SpellToken[] {
  const masked = maskNonProse(text, languageId);
  const tokens: SpellToken[] = [];
  const wordRe = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  let m: RegExpExecArray | null;

  while ((m = wordRe.exec(masked)) !== null) {
    const raw = m[0];
    const baseOffset = m.index;

    // Strip possessive suffix first
    const cleaned = raw.replace(/(?:'s|’s|'|’)$/i, '');
    if (cleaned.includes('-')) {
      let localIdx = 0;
      for (const seg of cleaned.split('-')) {
        if (seg && !shouldSkipToken(seg)) {
          tokens.push({
            word: seg,
            startOffset: baseOffset + localIdx,
            endOffset: baseOffset + localIdx + seg.length,
          });
        }
        localIdx += seg.length + 1;
      }
      continue;
    }

    if (!shouldSkipToken(cleaned)) {
      tokens.push({
        word: cleaned,
        startOffset: baseOffset,
        endOffset: baseOffset + cleaned.length,
      });
    }
  }

  return tokens;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

export class SpellDictionary {
  private readonly words = new Set<string>();
  private readonly customWords = new Set<string>();

  constructor(wordsIterable?: Iterable<string>) {
    for (const w of BUILTIN_ACADEMIC_WORDS) {
      this.words.add(w.toLowerCase());
    }
    if (wordsIterable) {
      for (const w of wordsIterable) {
        const clean = w.trim().toLowerCase();
        if (clean) {
          this.words.add(clean);
        }
      }
    }
  }

  static loadFromGzipFile(gzPath: string, ...systemFallbackPaths: string[]): SpellDictionary {
    let content = '';
    if (fs.existsSync(gzPath)) {
      content = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
    } else {
      for (const fallback of systemFallbackPaths) {
        if (fallback && fs.existsSync(fallback)) {
          content = fs.readFileSync(fallback, 'utf8');
          break;
        }
      }
    }
    const list = content ? content.split(/\r?\n/) : [];
    return new SpellDictionary(list);
  }

  setCustomWords(wordsIterable: Iterable<string>): void {
    this.customWords.clear();
    for (const w of wordsIterable) {
      const clean = w.trim().toLowerCase();
      if (clean) {
        this.customWords.add(clean);
      }
    }
  }

  addCustomWord(word: string): void {
    const clean = word.trim().toLowerCase();
    if (clean) {
      this.customWords.add(clean);
    }
  }

  isWordValid(word: string): boolean {
    const lower = word.toLowerCase();
    if (this.words.has(lower) || this.customWords.has(lower)) {
      return true;
    }
    // Common plural/possessive trim fallback
    if (lower.endsWith('s') && lower.length > 4) {
      const singular = lower.slice(0, -1);
      if (this.customWords.has(singular)) {
        return true;
      }
    }
    return false;
  }

  suggest(word: string, maxSuggestions = 6): string[] {
    const lower = word.toLowerCase();
    const isCapitalized = word.length > 0 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];

    const pushIfValid = (candidate: string) => {
      if (out.length >= maxSuggestions || seen.has(candidate)) {
        return;
      }
      if (this.words.has(candidate) || this.customWords.has(candidate)) {
        seen.add(candidate);
        out.push(isCapitalized ? candidate[0].toUpperCase() + candidate.slice(1) : candidate);
      }
    };

    const edits1 = generateEdits1(lower);
    for (const cand of edits1) {
      pushIfValid(cand);
      if (out.length >= maxSuggestions) {
        return out;
      }
    }

    // Limited edit-distance 2 fallback for short/medium words
    if (lower.length <= 12) {
      for (let i = 0; i < edits1.length && out.length < maxSuggestions; i++) {
        for (const cand2 of generateEdits1(edits1[i])) {
          pushIfValid(cand2);
          if (out.length >= maxSuggestions) {
            return out;
          }
        }
      }
    }

    return out;
  }
}

function generateEdits1(word: string): string[] {
  const results: string[] = [];
  const n = word.length;
  // Transpositions first (most common typing error)
  for (let i = 0; i < n - 1; i++) {
    results.push(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  // Deletions
  for (let i = 0; i < n; i++) {
    results.push(word.slice(0, i) + word.slice(i + 1));
  }
  // Replacements
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ALPHABET.length; c++) {
      const ch = ALPHABET[c];
      if (ch !== word[i]) {
        results.push(word.slice(0, i) + ch + word.slice(i + 1));
      }
    }
  }
  // Insertions
  for (let i = 0; i <= n; i++) {
    for (let c = 0; c < ALPHABET.length; c++) {
      results.push(word.slice(0, i) + ALPHABET[c] + word.slice(i));
    }
  }
  return results;
}

export function loadProjectDictionaryFile(projectRoot: string | null): string[] {
  if (!projectRoot) {
    return [];
  }
  const dictPath = path.join(projectRoot, '.dupe', 'dictionary.txt');
  try {
    return fs
      .readFileSync(dictPath, 'utf8')
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter((w) => Boolean(w) && !w.startsWith('#'));
  } catch {
    return [];
  }
}

export function appendWordToProjectDictionary(projectRoot: string, word: string): string {
  const clean = word.trim();
  const dupeDir = path.join(projectRoot, '.dupe');
  fs.mkdirSync(dupeDir, { recursive: true });
  const dictPath = path.join(dupeDir, 'dictionary.txt');
  const existing = loadProjectDictionaryFile(projectRoot);
  if (!existing.some((w) => w.toLowerCase() === clean.toLowerCase())) {
    const next = [...existing, clean].sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(dictPath, next.join('\n') + '\n', 'utf8');
  }
  return dictPath;
}
