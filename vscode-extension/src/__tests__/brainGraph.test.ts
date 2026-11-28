import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotesIndex, parseMarkdownFrontmatter } from '../notesIndex';

describe('Knowledge Brain & Unlinked Mentions', () => {
  it('parses frontmatter tags/aliases, resolves alias backlinks, detects ghosts & unlinked mentions, and filters local BFS', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupe-brain-'));
    try {
      fs.mkdirSync(path.join(tmp, 'notes', 'concepts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'notes', 'artifacts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.dupe', 'brain', 'topics'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'paper'), { recursive: true });

      const conceptContent = [
        '---',
        'type: concept',
        'status: active',
        'tags: [control, stability]',
        'aliases: [Action Smoothing]',
        '---',
        '',
        '# Policy Smoothing',
        '',
        'See [[MOC]] and [[missing-ablation]] plus [[paper:smith2024]].',
      ].join('\n');
      const { frontmatter } = parseMarkdownFrontmatter(conceptContent);
      expect(frontmatter.type).toBe('concept');
      expect(frontmatter.aliases).toEqual(['Action Smoothing']);

      const conceptAbs = path.join(tmp, 'notes', 'concepts', 'policy-smoothing.md');
      fs.writeFileSync(conceptAbs, conceptContent, 'utf8');
      fs.writeFileSync(path.join(tmp, 'notes', 'MOC.md'), '# Map of Content\n\nHub note.\n', 'utf8');
      fs.writeFileSync(
        path.join(tmp, 'notes', 'ablation.md'),
        '# Ablation\n\nEarlier pass mentioned Action Smoothing in plain text.\nNext pass links [[Action Smoothing]].\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmp, '.dupe', 'brain', 'topics', 'sim-debug.md'),
        '# Sim Debug\n\nSwarm note pointing to [[policy-smoothing]].\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmp, 'paper', 'main.tex'),
        '\\section{Intro}\nSee \\cite{smith2024}.\n',
        'utf8',
      );

      const idx = new NotesIndex();
      idx.rebuild(tmp);

      // Alias [[Action Smoothing]] resolves to policy-smoothing.md
      const backlinks = idx.getBacklinksForNote(conceptAbs);
      expect(backlinks.some((b) => b.sourceRelPath === 'notes/ablation.md')).toBe(true);

      // Plain-text "Action Smoothing" detected as unlinked mention
      const mentions = idx.getUnlinkedMentionsForNote(conceptAbs);
      expect(mentions.length).toBe(1);
      expect(mentions[0].matchedText).toBe('Action Smoothing');

      // Graph without agent blackboard omits .dupe/brain/, finds unresolved ghost
      const humanGraph = idx.buildBrainGraphPayload(tmp, [], { includeAgentBrain: false });
      expect(humanGraph.nodes.some((n) => n.kind === 'blackboard')).toBe(false);
      expect(humanGraph.nodes.some((n) => n.kind === 'ghost' && n.label === 'missing-ablation')).toBe(true);
      expect(humanGraph.nodes.some((n) => n.kind === 'tex' && n.path === 'paper/main.tex')).toBe(true);

      // Graph with agent blackboard includes .dupe/brain/
      const fullGraph = idx.buildBrainGraphPayload(tmp, [], { includeAgentBrain: true });
      expect(fullGraph.nodes.some((n) => n.kind === 'blackboard')).toBe(true);

      // Local 1-hop BFS around policy-smoothing includes direct neighbors only
      const localGraph = idx.buildBrainGraphPayload(tmp, [], {
        focusPath: conceptAbs,
        depth: 1,
        includeAgentBrain: false,
      });
      expect(localGraph.focusNodeId).toBe('note:notes/concepts/policy-smoothing.md');
      expect(localGraph.nodes.some((n) => n.id === 'tex:paper/main.tex')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
