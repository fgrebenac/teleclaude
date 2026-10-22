import { describe, it, expect, vi, beforeEach } from "vitest";
import { transcribeVoice } from "./transcribe.js";
import * as childProcess from "child_process";
import * as fs from "fs";

vi.mock("child_process");
vi.mock("fs");

describe("transcribeVoice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true); // whisper model present
  });

  function mockFfmpegSuccess(execFile: ReturnType<typeof vi.mocked<typeof childProcess.execFile>>) {
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return {} as any;
    });
  }

  it("calls ffmpeg then whisper-cli and returns transcript", async () => {
    const execFile = vi.mocked(childProcess.execFile);
    mockFfmpegSuccess(execFile);
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
      cb(null, "Hello world\n", "");
      return {} as any;
    });

    const result = await transcribeVoice("/tmp/test.ogg");
    expect(result).toBe("Hello world");

    expect(execFile).toHaveBeenCalledTimes(2);
    const [ffmpegCmd] = execFile.mock.calls[0] as unknown as [string, string[]];
    expect(ffmpegCmd).toBe("ffmpeg");

    const [whisperCmd, whisperArgs] = execFile.mock.calls[1] as unknown as [string, string[]];
    expect(whisperCmd).toBe("whisper-cli");
    expect(whisperArgs).toContain("--no-prints");
    expect(whisperArgs).toContain("--no-timestamps");
    expect(whisperArgs).toContain("/tmp/test.wav");
  });

  it("throws with install instructions when ffmpeg not found", async () => {
    const execFile = vi.mocked(childProcess.execFile);
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
      return {} as any;
    });

    await expect(transcribeVoice("/tmp/test.ogg")).rejects.toThrow("brew install ffmpeg");
  });

  it("throws with install instructions when whisper-cli not found", async () => {
    const execFile = vi.mocked(childProcess.execFile);
    mockFfmpegSuccess(execFile);
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
      return {} as any;
    });

    await expect(transcribeVoice("/tmp/test.ogg")).rejects.toThrow("brew install whisper-cpp");
  });

  it("throws if transcript is empty", async () => {
    const execFile = vi.mocked(childProcess.execFile);
    mockFfmpegSuccess(execFile);
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
      cb(null, "  \n", "");
      return {} as any;
    });

    await expect(transcribeVoice("/tmp/test.ogg")).rejects.toThrow("empty");
  });

  it("throws an actionable download hint when the whisper model is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const execFile = vi.mocked(childProcess.execFile);
    execFile.mockClear();

    await expect(transcribeVoice("/tmp/test.ogg")).rejects.toThrow("Whisper model missing");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("includes stderr in error message on failure", async () => {
    const execFile = vi.mocked(childProcess.execFile);
    mockFfmpegSuccess(execFile);
    execFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
      const err = new Error("exit code 1");
      cb(err, "", "model file not found");
      return {} as any;
    });

    await expect(transcribeVoice("/tmp/test.ogg")).rejects.toThrow("model file not found");
  });
});
