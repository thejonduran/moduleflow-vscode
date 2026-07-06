export const startMarker = "// @moduleflow:start";
export const endMarker = "// @moduleflow:end";

export type ModuleFlowRegionInspection =
  | {
      ok: true;
      hasRegion: false;
    }
  | {
      ok: true;
      hasRegion: true;
      start: number;
      end: number;
      contentStart: number;
      contentEnd: number;
      regionEnd: number;
      startLine: number;
      endLine: number;
    }
  | {
      ok: false;
      message: string;
      startLines: number[];
      endLines: number[];
    };

export type WritableModuleFlowRegionInspection = Extract<ModuleFlowRegionInspection, { ok: true }>;

type MarkerMatch = {
  index: number;
  line: number;
  marker: string;
};

const knownMetadataPattern = /^[ \t]*\/\/[ \t]*@moduleflow:(?:start|end|node\b.*|node:end\b.*|description\b.*|code\b.*)[ \t]*$/;
const moduleFlowCommentPattern = /^[ \t]*\/\/[ \t]*@moduleflow:\S.*$/gm;

function markerMatches(source: string, marker: string): MarkerMatch[] {
  const matches: MarkerMatch[] = [];
  const pattern = new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "gm");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    matches.push({
      index: match.index,
      line: source.slice(0, match.index).split(/\r?\n/).length,
      marker: match[0]
    });
  }

  return matches;
}

function unknownModuleFlowMetadataLines(source: string): number[] {
  const lines: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = moduleFlowCommentPattern.exec(source))) {
    if (knownMetadataPattern.test(match[0])) {
      continue;
    }

    lines.push(source.slice(0, match.index).split(/\r?\n/).length);
  }

  return lines;
}

function markerEnd(source: string, match: MarkerMatch): number {
  const lineEnd = source.indexOf("\n", match.index);
  return lineEnd >= 0 ? lineEnd + 1 : source.length;
}

function invalidRegionMessage(startLines: number[], endLines: number[], unknownLines: number[]): string {
  const starts = startLines.length === 0 ? "none" : startLines.join(", ");
  const ends = endLines.length === 0 ? "none" : endLines.join(", ");
  const unknown = unknownLines.length === 0 ? "" : ` Unknown ModuleFlow metadata lines: ${unknownLines.join(", ")}.`;
  return `ModuleFlow refused to write because the file contains an invalid ModuleFlow region. Start marker lines: ${starts}. End marker lines: ${ends}.${unknown}`;
}

export function inspectModuleFlowRegion(source: string): ModuleFlowRegionInspection {
  const starts = markerMatches(source, startMarker);
  const ends = markerMatches(source, endMarker);
  const unknownLines = unknownModuleFlowMetadataLines(source);

  if (starts.length === 0 && ends.length === 0 && unknownLines.length === 0) {
    return { ok: true, hasRegion: false };
  }

  if (starts.length !== 1 || ends.length !== 1 || ends[0].index <= starts[0].index || unknownLines.length > 0) {
    return {
      ok: false,
      message: invalidRegionMessage(starts.map((match) => match.line), ends.map((match) => match.line), unknownLines),
      startLines: starts.map((match) => match.line),
      endLines: ends.map((match) => match.line)
    };
  }

  return {
    ok: true,
    hasRegion: true,
    start: starts[0].index,
    end: ends[0].index,
    contentStart: markerEnd(source, starts[0]),
    contentEnd: ends[0].index,
    regionEnd: markerEnd(source, ends[0]),
    startLine: starts[0].line,
    endLine: ends[0].line
  };
}

export function assertWritableModuleFlowRegion(source: string): WritableModuleFlowRegionInspection {
  const inspection = inspectModuleFlowRegion(source);
  if (!inspection.ok) {
    throw new Error(inspection.message);
  }

  return inspection;
}
