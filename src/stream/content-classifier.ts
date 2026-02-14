import { Logger } from '../logging/logger';

const logger = new Logger('content-classifier');

export interface ClassificationResult {
  isStructured: boolean;
  reason: string;
  description: string;
}

/**
 * Classifies content to determine if it contains structured markdown
 * that should be uploaded as a file rather than rendered inline.
 *
 * Detection rules (checked in order, first match wins):
 * 1. Mermaid diagrams
 * 2. Large code blocks (10+ lines)
 * 3. Multiple code blocks (2+)
 * 4. Markdown tables
 * 5. Structured documents (3+ headers)
 * 6. Default: conversational
 */
export function classifyContent(text: string): ClassificationResult {
  // Handle empty or whitespace-only text
  if (!text || text.trim().length === 0) {
    return {
      isStructured: false,
      reason: 'conversational',
      description: 'Empty or whitespace-only content'
    };
  }

  // Extract code fences with their content and language
  const codeFences = extractCodeFences(text);

  // 1. Check for Mermaid diagrams
  const mermaidBlock = codeFences.find(fence => fence.language === 'mermaid');
  if (mermaidBlock) {
    const diagramType = extractMermaidType(mermaidBlock.content);
    return {
      isStructured: true,
      reason: 'mermaid_diagram',
      description: `Mermaid ${diagramType} diagram`
    };
  }

  // 2. Check for large code block (10+ lines)
  const largeCodeBlock = codeFences.find(fence => {
    const lineCount = countNonEmptyLines(fence.content);
    return lineCount >= 10;
  });
  if (largeCodeBlock) {
    const lineCount = countNonEmptyLines(largeCodeBlock.content);
    return {
      isStructured: true,
      reason: 'code_block',
      description: largeCodeBlock.language
        ? `${largeCodeBlock.language} code (${lineCount} lines)`
        : `Code block (${lineCount} lines)`
    };
  }

  // 3. Check for multiple code blocks
  if (codeFences.length >= 2) {
    return {
      isStructured: true,
      reason: 'multiple_code_blocks',
      description: `Response with ${codeFences.length} code blocks`
    };
  }

  // Remove code fences from text for subsequent checks
  const textWithoutCode = removeCodeFences(text);

  // 4. Check for markdown tables
  if (hasMarkdownTable(textWithoutCode)) {
    return {
      isStructured: true,
      reason: 'table',
      description: 'Response with markdown table'
    };
  }

  // 5. Check for structured document (3+ headers)
  const headerCount = countMarkdownHeaders(textWithoutCode);
  if (headerCount >= 3) {
    return {
      isStructured: true,
      reason: 'structured_document',
      description: `Document with ${headerCount} sections`
    };
  }

  // 6. Default: conversational
  return {
    isStructured: false,
    reason: 'conversational',
    description: 'Conversational response'
  };
}

interface CodeFence {
  language: string;
  content: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Extracts all code fences from text with their language and content.
 */
function extractCodeFences(text: string): CodeFence[] {
  const fences: CodeFence[] = [];
  const fenceRegex = /```(\w*)\n([\s\S]*?)```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    fences.push({
      language: match[1] || '',
      content: match[2] || '',
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }

  return fences;
}

/**
 * Removes all code fences from text, replacing them with placeholders.
 */
function removeCodeFences(text: string): string {
  return text.replace(/```(\w*)\n[\s\S]*?```/g, '');
}

/**
 * Counts non-empty lines in a string.
 */
function countNonEmptyLines(content: string): number {
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .length;
}

/**
 * Extracts the diagram type from mermaid content.
 * Common types: flowchart, sequenceDiagram, classDiagram, gantt, etc.
 */
function extractMermaidType(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() || '';

  // Common mermaid diagram types
  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph')) {
    return 'flowchart';
  }
  if (firstLine.startsWith('sequenceDiagram')) {
    return 'sequence';
  }
  if (firstLine.startsWith('classDiagram')) {
    return 'class';
  }
  if (firstLine.startsWith('gantt')) {
    return 'gantt';
  }
  if (firstLine.startsWith('pie')) {
    return 'pie';
  }
  if (firstLine.startsWith('erDiagram')) {
    return 'ER';
  }
  if (firstLine.startsWith('journey')) {
    return 'user journey';
  }
  if (firstLine.startsWith('gitGraph')) {
    return 'git graph';
  }
  if (firstLine.startsWith('stateDiagram')) {
    return 'state';
  }

  return 'diagram';
}

/**
 * Checks if text contains a markdown table.
 * GFM table syntax: lines with |...|...| followed by separator |---|---|
 */
function hasMarkdownTable(text: string): boolean {
  const lines = text.split('\n');

  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = lines[i].trim();
    const nextLine = lines[i + 1].trim();

    // Check if current line looks like a table header (has pipes)
    if (currentLine.includes('|') && currentLine.split('|').length >= 3) {
      // Check if next line is a separator (contains only pipes, dashes, colons, and spaces)
      if (/^\|?[\s\-:|]+\|?$/.test(nextLine) && nextLine.includes('-')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Counts markdown headers (## or ###) outside of code fences.
 */
function countMarkdownHeaders(text: string): number {
  const lines = text.split('\n');
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Match headers starting with ## or ###
    if (/^#{2,3}\s+.+/.test(trimmed)) {
      count++;
    }
  }

  return count;
}
