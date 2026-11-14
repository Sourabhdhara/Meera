import { BaseTool } from "../base";

export class ReadFileTool extends BaseTool {
  name = "read_file";
  description = "Reads text contents from a local file safely. Supports path shortcuts like '~/Desktop'. Optionally specify start_line and end_line for surgical code reading.";

  async run(args: { path: string; max_characters?: number; start_line?: number; end_line?: number }) {
    const res = await this.files.readText(args.path, args.max_characters, args.start_line, args.end_line);
    if (!res.ok) this.fail(res.error || "Read failed");
    return { result: res.content, path: res.path, total_lines: res.totalLines, truncated: res.truncated };
  }
}

export class EditFileTool extends BaseTool {
  name = "edit_file";
  description = "Surgically edits a file by finding an exact target snippet and replacing it with the replacement snippet. Guarantees safety without rewriting the entire file.";

  async run(args: { path: string; target: string; replacement: string }) {
    const res = await this.files.editFileContent(args.path, args.target, args.replacement);
    if (!res.ok) this.fail(res.error || "Edit failed");
    return { result: `Successfully replaced ${res.replacements} occurrence(s) in '${args.path}'.`, path: res.path };
  }
}

export class SearchCodebaseTool extends BaseTool {
  name = "search_codebase";
  description = "Searches for text, function names, variables, or error strings across all source files in a directory (like ripgrep/grep), returning matching files and line numbers.";

  async run(args: { query: string; search_directory?: string; max_results?: number }) {
    const res = await this.files.searchCodebase(args.query, args.search_directory || ".", args.max_results || 30);
    if (!res.ok) this.fail(res.error || "Codebase search failed");
    return { matches: res.matches, total_matches: res.count };
  }
}

export class WriteFileTool extends BaseTool {
  name = "write_file";
  description = "Writes text content to a local file, creating parent directories automatically.";

  async run(args: { path: string; content: string }) {
    const res = await this.files.writeText(args.path, args.content);
    if (!res.ok) this.fail(res.error || "Write failed");
    return { result: res.result, path: res.path };
  }
}

export class AppendFileTool extends BaseTool {
  name = "append_to_file";
  description = "Appends a note or text to a file with an automatic timestamp (great for logs or notes).";

  async run(args: { path: string; content: string }) {
    const res = await this.files.appendText(args.path, args.content, true);
    if (!res.ok) this.fail(res.error || "Append failed");
    return { result: res.result, path: res.path };
  }
}

export class ListFolderTool extends BaseTool {
  name = "list_folder";
  description = "Lists files and subdirectories in a directory with file sizes and modified dates.";

  async run(args: { folder_path?: string }) {
    const res = await this.files.listDir(args?.folder_path || "~/Desktop");
    if (!res.ok) this.fail(res.error || "Folder listing failed");
    return { result: res.entries, count: res.count, directory: res.directory };
  }
}

export class SearchFilesTool extends BaseTool {
  name = "search_files";
  description = "Searches for files matching a filename or extension pattern recursively.";

  async run(args: { filename_query: string; search_directory?: string }) {
    const res = await this.files.search(args.filename_query, args.search_directory || "~");
    return { result: res.matches, count: res.count };
  }
}

export class RecycleFileTool extends BaseTool {
  name = "recycle_file";
  description = "Safely moves a file or folder to the Windows Recycle Bin (never permanently deletes).";

  async run(args: { path: string }) {
    const res = await this.files.safeDelete(args.path);
    if (!res.ok) this.fail(res.error || "Delete failed");
    return { result: res.result };
  }
}

export class WriteToNotepadTool extends BaseTool {
  name = "write_to_notepad";
  description = "Writes or replaces text in Notepad and opens it immediately on screen (ideal for writing out conversation transcripts, notes, code, or logs).";

  async run(args: { content: string; title?: string }) {
    const res = this.files.writeToNotepad(args.content, args.title);
    return { result: res.result, path: res.path };
  }
}

export class ReadDocumentTool extends BaseTool {
  name = "read_document";
  description = "Extracts and reads full text content from documents, digital or scanned PDFs (.pdf), Word documents (.docx), or image files (.png/.jpg/.jpeg/.webp/.bmp/.tiff via OCR) in the background.";

  async run(args: { path: string; max_characters?: number }) {
    if (!args?.path) this.fail("File path is required.");
    const ext = (args.path.split(".").pop() || "").toLowerCase();

    // 1. Any image format -> Windows Native OCR
    if (["png", "jpg", "jpeg", "bmp", "tiff", "tif", "webp"].includes(ext)) {
      const ocrRes = await this.screen.extractAllTextFromImage(args.path);
      if (!ocrRes.ok) this.fail(ocrRes.error || "OCR failed on image.");
      return { result: ocrRes.text, format: ext, total_lines: ocrRes.count, source: "Windows.Media.Ocr" };
    }

    // 2. Pure Node.js parser (pdf-parse / mammoth)
    const docRes = await this.files.readDocumentText(args.path, args.max_characters || 25000);

    // 3. Fallback for Scanned PDF: If PDF has no digital text stream, automatically run native PDF OCR!
    if (ext === "pdf" && (!docRes.ok || !docRes.text || docRes.text.trim().length < 15)) {
      const scannedRes = await this.screen.ocrScannedPdf(args.path, 5);
      if (scannedRes.ok && scannedRes.text) {
        return {
          result: scannedRes.text,
          format: "scanned_pdf",
          source: "Windows.Data.Pdf + Windows.Media.Ocr",
          pages_processed: scannedRes.pagesProcessed
        };
      }
    }

    if (!docRes.ok) this.fail(docRes.error || "Document reading failed.");
    return { result: docRes.text, format: docRes.format, pages: docRes.pages };
  }
}

