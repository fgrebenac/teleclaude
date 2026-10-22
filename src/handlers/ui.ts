import { writeFileSync } from "fs";
import { Bot } from "grammy";

/** Download a Telegram file to a local path. */
export async function downloadFile(bot: Bot, fileId: string, destPath: string): Promise<void> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
}
