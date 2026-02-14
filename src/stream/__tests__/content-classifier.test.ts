import { describe, it, expect } from 'vitest';
import { classifyContent } from '../content-classifier';

describe('classifyContent', () => {
  describe('conversational text', () => {
    it('classifies empty string as conversational', () => {
      const result = classifyContent('');
      expect(result.isStructured).toBe(false);
      expect(result.reason).toBe('conversational');
    });

    it('classifies whitespace-only as conversational', () => {
      const result = classifyContent('   \n\n  ');
      expect(result.isStructured).toBe(false);
    });

    it('classifies simple text as conversational', () => {
      const result = classifyContent('Sure, I can help with that. Here is how you do it.');
      expect(result.isStructured).toBe(false);
      expect(result.reason).toBe('conversational');
    });

    it('classifies text with inline backticks as conversational', () => {
      const result = classifyContent('Use `console.log()` to print and `typeof` to check types.');
      expect(result.isStructured).toBe(false);
    });
  });

  describe('mermaid diagrams', () => {
    it('detects mermaid flowchart', () => {
      const text = 'Here is the architecture:\n\n```mermaid\nflowchart LR\n  A-->B\n  B-->C\n```';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('mermaid_diagram');
      expect(result.description).toContain('flowchart');
    });

    it('detects mermaid sequence diagram', () => {
      const text = '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi\n```';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('mermaid_diagram');
      expect(result.description).toContain('sequence');
    });

    it('detects mermaid class diagram', () => {
      const text = '```mermaid\nclassDiagram\n  Animal <|-- Duck\n```';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('mermaid_diagram');
    });
  });

  describe('large code blocks', () => {
    it('detects code block with 10+ lines', () => {
      const lines = Array.from({ length: 15 }, (_, i) => `  const x${i} = ${i};`).join('\n');
      const text = `Here's the code:\n\n\`\`\`typescript\n${lines}\n\`\`\``;
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('code_block');
      expect(result.description).toContain('typescript');
      expect(result.description).toContain('15');
    });

    it('does NOT detect short code block (under 10 lines)', () => {
      const text = '```python\nprint("hello")\nprint("world")\nprint("!")\n```';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(false);
      expect(result.reason).toBe('conversational');
    });

    it('detects code block without language specifier', () => {
      const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
      const text = `\`\`\`\n${lines}\n\`\`\``;
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('code_block');
      expect(result.description).toContain('Code block');
    });
  });

  describe('multiple code blocks', () => {
    it('detects 2 code blocks even if each is small', () => {
      const text = '```js\nconst a = 1;\n```\n\nAnd then:\n\n```js\nconst b = 2;\n```';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('multiple_code_blocks');
      expect(result.description).toContain('2');
    });

    it('detects 3 code blocks', () => {
      const text = '```js\na();\n```\n\n```py\nb()\n```\n\n```rust\nc();\n```';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('multiple_code_blocks');
      expect(result.description).toContain('3');
    });
  });

  describe('markdown tables', () => {
    it('detects GFM table', () => {
      const text = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('table');
    });

    it('detects table with alignment markers', () => {
      const text = '| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('table');
    });
  });

  describe('structured documents', () => {
    it('detects document with 3+ headers', () => {
      const text = '## Introduction\n\nSome text.\n\n## Methods\n\nMore text.\n\n## Results\n\nFinal text.';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(true);
      expect(result.reason).toBe('structured_document');
      expect(result.description).toContain('3');
    });

    it('does NOT trigger with only 2 headers', () => {
      const text = '## Part 1\n\nSome text.\n\n## Part 2\n\nMore text.';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(false);
    });

    it('does NOT count headers inside code fences', () => {
      const text = '```markdown\n## Fake Header 1\n## Fake Header 2\n## Fake Header 3\n```\n\nJust a normal reply.';
      const result = classifyContent(text);
      expect(result.isStructured).toBe(false);
    });
  });

  describe('priority ordering', () => {
    it('mermaid takes priority over multiple code blocks', () => {
      const text = '```mermaid\nflowchart LR\n  A-->B\n```\n\n```js\nconst a = 1;\n```';
      const result = classifyContent(text);
      expect(result.reason).toBe('mermaid_diagram');
    });

    it('large code block takes priority over multiple blocks', () => {
      const lines = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
      const text = `\`\`\`ts\n${lines}\n\`\`\`\n\n\`\`\`js\nsmall()\n\`\`\``;
      const result = classifyContent(text);
      expect(result.reason).toBe('code_block');
    });
  });
});
