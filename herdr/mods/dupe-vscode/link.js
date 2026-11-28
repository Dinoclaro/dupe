import { exec } from "herdr";

const CODE_CANDIDATES = [
  "code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  "/usr/local/bin/code",
  "/usr/bin/code",
];

export async function handleLink(click) {
  if (!click || click.source?.machine) {
    return "pass";
  }
  if (click.link?.kind !== "file" || !click.link?.path) {
    return "pass";
  }

  let target = click.link.path;
  if (typeof click.link.line === "number" && click.link.line > 0) {
    target += `:${click.link.line}`;
    if (typeof click.link.column === "number" && click.link.column > 0) {
      target += `:${click.link.column}`;
    }
  }

  const opts = {
    cwd: click.source?.cwd || undefined,
    timeout: 5000,
  };

  for (const bin of CODE_CANDIDATES) {
    try {
      const res = await exec(bin, ["-g", target], opts);
      if (res.code === 0) {
        return "handled";
      }
    } catch {
      // Try next VS Code binary candidate
    }
  }
  return "pass";
}
