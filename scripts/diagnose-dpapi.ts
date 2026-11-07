import { spawnSync } from "node:child_process";

const roundtrip = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$hex = [Console]::In.ReadToEnd().Trim()",
  "$bytes = [byte[]]::new([int]($hex.Length / 2))",
  "for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }",
  "$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "$plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "if ([Convert]::ToBase64String($bytes) -ne [Convert]::ToBase64String($plain)) { exit 2 }",
].join("; ");

for (const [label, script] of [
  ["exit", "exit 0"],
  ["stdin", "$null = [Console]::In.ReadToEnd(); exit 0"],
  ["roundtrip", roundtrip],
  ["roundtrip-no-stdin", roundtrip.replace("[Console]::In.ReadToEnd().Trim()", "('01' * 32)")],
]) {
  const start = performance.now();
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `try { ${script}; exit 0 } catch { Write-Output ($_.Exception.GetType().FullName); exit 1 }`,
    ],
    {
      input: "01".repeat(32),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const exception = result.stdout.trim();
  console.log(
    `bun-${label} exit=${result.status} ms=${Math.round(performance.now() - start)} exception=${/^[A-Za-z][A-Za-z0-9.]*Exception$/.test(exception) ? exception : "none"} spawnError=${result.error?.name ?? "none"}`,
  );
}
