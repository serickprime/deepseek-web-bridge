import { spawn } from "node:child_process";

export type SupportedPlatform = "win32" | "darwin" | "linux";
export type LinuxFolderPicker = "zenity" | "kdialog";

export interface SystemCapabilities {
  platform: SupportedPlatform;
  folderPicker: boolean;
  claudeCodeLaunch: boolean;
  openCodeLaunch: boolean;
}

export type CommandAvailability = (command: string) => Promise<boolean>;

export function isCommandAvailable(command: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    const child = spawn(command, ["--version"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.once("spawn", () => finish(true));
    child.once("error", () => finish(false));
  });
}

export async function findLinuxFolderPicker(
  commandAvailable: CommandAvailability = isCommandAvailable,
): Promise<LinuxFolderPicker | null> {
  if (await commandAvailable("zenity")) return "zenity";
  if (await commandAvailable("kdialog")) return "kdialog";
  return null;
}

export async function getSystemCapabilities(
  platform: NodeJS.Platform = process.platform,
  commandAvailable: CommandAvailability = isCommandAvailable,
): Promise<SystemCapabilities> {
  if (platform === "win32") {
    return { platform, folderPicker: true, claudeCodeLaunch: true, openCodeLaunch: true };
  }
  if (platform === "darwin") {
    return { platform, folderPicker: true, claudeCodeLaunch: false, openCodeLaunch: false };
  }
  if (platform === "linux") {
    const folderPicker = (await findLinuxFolderPicker(commandAvailable)) !== null;
    return { platform, folderPicker, claudeCodeLaunch: false, openCodeLaunch: false };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
