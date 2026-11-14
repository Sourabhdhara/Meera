import { BaseTool } from "../base";

export class ReadFileTool extends BaseTool {
  name = "read_file";
  description = "Reads text contents from a local file safely. Supports path shortcuts like '~/Desktop' or '~/Downloads'.";

  async run(args: { path: string; max_characters?: number }) {
    const res = await this.files.readText(args.path, args.max_characters);
    if (!res.ok) this.fail(res.error || "Read failed");
    return { result: res.content, path: res.path, truncated: res.truncated };
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

