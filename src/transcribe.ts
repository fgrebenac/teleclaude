import { execFile } from "child_process";
import { unlinkSync, existsSync } from "fs";
import { log } from "./log.js";

const WHISPER_MODEL = "base";

/**
 * Transcribe an OGG/Opus voice file to text using whisper-cli.
 * Telegram sends OGG/Opus; whisper-cli only handles OGG/Vorbis, so we
 * convert to WAV via ffmpeg first.
 */
export async function transcribeVoice(oggPath: string): Promise<string> {
  const model = modelPath();
  if (!existsSync(model)) {
    // Pre-flight: without this, a missing model surfaces as a raw whisper-cli
    // stderr dump instead of something actionable.
    throw new Error(
      `Whisper model missing at ${model}. Download it with:\n` +
      `curl -L --create-dirs -o ${model} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin`,
    );
  }
  const wavPath = oggPath.replace(/\.ogg$/, ".wav");
  try {
    await run(
      "ffmpeg",
      ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
      "ffmpeg not found. Install with: brew install ffmpeg",
    );

    const stdout = await run(
      "whisper-cli",
      ["-m", model, "--no-prints", "--no-timestamps", "-l", "auto", wavPath],
      "whisper-cli not found. Install with: brew install whisper-cpp",
    );

    const transcript = stdout.trim();
    if (!transcript) {
      throw new Error("Transcription returned empty result");
    }

    log(`[transcribe] ${transcript.length} chars from ${oggPath}`);
    return transcript;
  } finally {
    try { unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

function modelPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return `${home}/.teleclaude/models/ggml-${WHISPER_MODEL}.bin`;
}

function run(cmd: string, args: string[], notFoundMsg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(notFoundMsg));
        } else {
          reject(new Error(`${cmd} failed: ${stderr || err.message}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
}
