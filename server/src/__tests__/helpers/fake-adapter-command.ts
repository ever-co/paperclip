/**
 * Cross-platform helper for creating fake adapter CLI commands in tests.
 *
 * On Unix: writes a file with a `#!/usr/bin/env node` shebang and chmod 755.
 * On Windows: writes a `.js` file and a `.cmd` wrapper that invokes `node`.
 *
 * Returns the path that should be passed as the adapter `command`.
 */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a fake adapter command that uses Node.js as its runtime.
 *
 * @param commandPath - The desired path for the command (without extension).
 *   On Unix this is written directly; on Windows a `.js` + `.cmd` pair is created.
 * @param scriptBody - The Node.js script body (without shebang).
 * @returns The path to pass as the adapter command.
 */
export async function writeFakeNodeCommand(commandPath: string, scriptBody: string): Promise<string> {
  if (process.platform === "win32") {
    const jsPath = `${commandPath}.js`;
    const cmdPath = `${commandPath}.cmd`;
    await fs.writeFile(jsPath, scriptBody, "utf8");
    await fs.writeFile(
      cmdPath,
      `@node "%~dp0${path.basename(jsPath)}" %*\r\n`,
      "utf8",
    );
    return cmdPath;
  }

  await fs.writeFile(commandPath, `#!/usr/bin/env node\n${scriptBody}`, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

/**
 * Write a fake adapter command that uses shell scripting (sh on Unix, cmd on Windows).
 *
 * @param commandPath - The desired path for the command (without extension).
 * @param unixScript - The shell script body for Unix (lines without shebang).
 * @param windowsScript - The batch script body for Windows (lines without @echo off).
 * @returns The path to pass as the adapter command.
 */
export async function writeFakeShellCommand(
  commandPath: string,
  unixScript: string[],
  windowsScript: string[],
): Promise<string> {
  if (process.platform === "win32") {
    const cmdPath = `${commandPath}.cmd`;
    await fs.writeFile(
      cmdPath,
      ["@echo off", ...windowsScript, ""].join("\r\n"),
      "utf8",
    );
    return cmdPath;
  }

  await fs.writeFile(
    commandPath,
    ["#!/bin/sh", ...unixScript, ""].join("\n"),
    "utf8",
  );
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}
