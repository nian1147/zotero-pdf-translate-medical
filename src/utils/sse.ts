/** Buffer SSE records independently of network chunk boundaries. */
export function createSSEParser(onData: (data: string) => void) {
  let buffer = "";
  let dataLines: string[] = [];
  let firstLine = true;

  function dispatch() {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    onData(data);
  }

  function consumeLine(line: string) {
    if (firstLine) {
      line = line.replace(/^\uFEFF/, "");
      firstLine = false;
    }
    if (!line) {
      dispatch();
    } else if (line === "data") {
      dataLines.push("");
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  function drain(final: boolean) {
    const lineBreak = /\r\n|\r|\n/g;
    let offset = 0;
    let match: RegExpExecArray | null;
    while ((match = lineBreak.exec(buffer))) {
      // A trailing CR can be the first half of a CRLF in the next chunk.
      if (!final && match[0] === "\r" && match.index === buffer.length - 1)
        break;
      consumeLine(buffer.slice(offset, match.index));
      offset = match.index + match[0].length;
    }
    buffer = buffer.slice(offset);
    if (final) {
      if (buffer) consumeLine(buffer);
      buffer = "";
      dispatch();
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}
