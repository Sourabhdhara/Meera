import { BaseTool } from "../base";

export class RunCommandTool extends BaseTool {
  name = "execute_command";
  description = "Executes a Windows shell / CMD command or batch script (e.g. 'dir', 'ipconfig', 'netstat', 'ping', 'where'). Captures stdout and stderr.";

  async run(args: { command?: string; cmd?: string; code?: string; timeout_seconds?: number }) {
    let cmd = "";
    if (args?.code && args.code.trim()) {
      cmd = args.code;
    } else if (args?.cmd && args.cmd.trim()) {
      cmd = args.cmd;
    } else if (args?.command && args.command.trim()) {
      cmd = args.command;
    }

    if (!cmd.trim()) this.fail("Command is required.");
    const res = await this.script.runCommand(cmd, args?.timeout_seconds || 15);
    if (!res.ok) this.fail(res.stderr || "Command failed");
    return { result: res.result, stdout: res.stdout, returncode: res.returncode };
  }
}

export class RunPowerShellScriptTool extends BaseTool {
  name = "execute_powershell_script";
  description = "Executes a PowerShell command or script to query Windows management instrumentation, check services, or perform system administration tasks.";

  async run(args: { command?: string; script?: string; code?: string; timeout_seconds?: number }) {
    // LLMs often put descriptive comments in 'command' and actual PowerShell code in 'code' or 'script'.
    // If 'code' or 'script' contains actual PowerShell syntax, prioritize it over a plain narrative 'command'.
    let s = "";
    if (args?.code && args.code.trim()) {
      s = args.code;
    } else if (args?.script && args.script.trim()) {
      s = args.script;
    } else if (args?.command && args.command.trim()) {
      s = args.command;
    }

    if (!s.trim()) this.fail("PowerShell script code is required.");
    // Respect the timeout decided dynamically by Gemini; default to 60s if unspecified
    const timeout = Math.max(5, args?.timeout_seconds || 60);
    const res = await this.script.runPowerShell(s, timeout);
    if (!res.ok) this.fail(res.stderr || "PowerShell script failed");
    return { result: res.result, stdout: res.stdout, returncode: res.returncode };
  }
}

export class RunPowerShellVisibleTool extends BaseTool {
  name = "execute_powershell_script_visible";
  description = "Opens a visible PowerShell console in the foreground and runs the requested PowerShell command or script in it. Use only when the user explicitly asks to open/show PowerShell or run it visibly in front of them.";

  async run(args: { command?: string; script?: string; code?: string }) {
    const script = args?.code?.trim() || args?.script?.trim() || args?.command?.trim() || "";
    if (!script) this.fail("PowerShell script code is required.");

    // Keep the visible console open so the user can see the command and output.
    // The safety check is shared with the hidden execution path.
    const safetyErr = this.script.checkSafetyForVisibleExecution(script);
    if (safetyErr) this.fail(safetyErr);
    const result = await this.script.runPowerShellVisible(script);
    if (!result.ok) this.fail(result.stderr || "Visible PowerShell execution failed");
    return { result: result.result, output: result.output, pid: result.pid };
  }
}

export class SaveAutomationTool extends BaseTool {
  name = "save_automation_script";
  description = "Saves a reusable automation script (PowerShell or Batch) to MEERA's persistent library so it can be re-run at any time by name.";

  async run(args: { script_name?: string; name?: string; code?: string; script?: string; language?: string; description?: string }) {
    const name = args?.script_name || args?.name || "untitled";
    const code = args?.code || args?.script || "";
    const res = await this.script.saveAutomation(name, code, args?.language, args?.description);
    if (!res.ok) this.fail("Failed saving automation script");
    return { result: res.result, file: res.file };
  }
}

export class RunAutomationTool extends BaseTool {
  name = "run_automation_script";
  description = "Executes a previously saved automation script by its name.";

  async run(args: { script_name?: string; name?: string; timeout_seconds?: number }) {
    const name = args?.script_name || args?.name || "";
    const res = await this.script.runAutomation(name, args?.timeout_seconds || 30);
    if (!res.ok) this.fail(res.stderr || "Automation execution failed");
    return { result: res.result, stdout: res.stdout, returncode: res.returncode };
  }
}

export class ListAutomationsTool extends BaseTool {
  name = "list_automation_scripts";
  description = "Lists all saved persistent automation scripts in MEERA's library.";

  async run() {
    const res = await this.script.listAutomations();
    return { result: res.automations, count: res.count };
  }
}

export class DeleteAutomationTool extends BaseTool {
  name = "delete_automation_script";
  description = "Deletes a saved automation script from MEERA's library.";

  async run(args: { script_name?: string; name?: string }) {
    const name = args?.script_name || args?.name || "";
    const res = await this.script.deleteAutomation(name);
    return { result: res.result };
  }
}

export class TraceGitChangesTool extends BaseTool {
  name = "trace_git_changes";
  description = "Performs deep forensic inspection on a Git repository: inspects recent commits, unstaged changes, modified files, diff summaries, or what changed since last night.";

  async run(args: { mode?: "status" | "recent_commits" | "diff" | "last_night"; repo_path?: string; max_commits?: number }) {
    const mode = args?.mode || "status";
    const repoPath = args?.repo_path || ".";
    const maxCommits = args?.max_commits || 5;

    let gitCmd = "git status -s";
    if (mode === "recent_commits") {
      gitCmd = `git log -n ${maxCommits} --oneline --decorate`;
    } else if (mode === "diff") {
      gitCmd = `git diff --stat`;
    } else if (mode === "last_night") {
      gitCmd = `git log --since="yesterday" --oneline && git diff --stat`;
    }

    const res = await this.script.runPowerShell(`Set-Location "${repoPath}"; ${gitCmd}`, 15);
    if (!res.ok) this.fail(res.stderr || "Git forensic trace failed");
    return { mode, output: res.stdout || res.result || "No changes or commits detected." };
  }
}

