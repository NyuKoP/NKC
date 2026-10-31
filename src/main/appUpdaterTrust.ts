import { execFile } from "node:child_process";
import path from "node:path";

export const assertUpdateTrust = (config: unknown, platform: string) => {
  if (!config || typeof config !== "object" || !("provider" in config) || config.provider !== "github" ||
      !("owner" in config) || config.owner !== "NyuKoP" || !("repo" in config) || config.repo !== "NKC") {
    throw new Error("UPDATE_TRUST_INVALID");
  }

  if (platform === "win32") {
    const publishers = "publisherName" in config ? config.publisherName : undefined;
    const names = Array.isArray(publishers) ? publishers : [publishers];

    if (!names.length || names.some(name => typeof name !== "string" || !name.trim())) throw new Error("UPDATE_TRUST_INVALID");
  }
};

// Upstream can skip verification when PowerShell is unavailable; every local verifier failure must reject.
export const verifyWindowsUpdateSignature = (publishers: string[], file: string): Promise<string | null> =>
  new Promise(resolve => {
    const script = "$ErrorActionPreference='Stop'; $s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:NKC_UPDATE_VERIFY_PATH; " +
      "@{path=$s.Path;status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;name=$s.SignerCertificate.GetNameInfo('SimpleName',$false)} | ConvertTo-Json -Compress";
    execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
        env: { ...process.env,
          PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
          NKC_UPDATE_VERIFY_PATH: file } }, (error, stdout, stderr) => {
        if (error || stderr) { resolve("UPDATE_SIGNATURE_VERIFICATION_FAILED"); return; }
        try {
          const signature = JSON.parse(stdout);
          resolve(signature.status === "Valid" && typeof signature.path === "string" &&
            path.resolve(signature.path) === path.resolve(file) &&
            publishers.some(name => name === signature.subject || name === signature.name) ? null : "UPDATE_SIGNATURE_INVALID");
        } catch { resolve("UPDATE_SIGNATURE_VERIFICATION_FAILED"); }
      });
  });
