import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const PORT = Number(process.env.PORT || 8080);
const AUTH_SECRET = String(process.env.TRAILER_MUXER_SECRET || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const OUTPUT_BUCKET = String(process.env.TRAILER_OUTPUT_BUCKET || "post-images").trim();

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const app = express();
app.use(express.json({ limit: "1mb" }));

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${cmd} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function normalizeOutputPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return `${crypto.randomUUID()}.mp4`;
  return raw.replace(/^\/+/, "").replace(/\.\./g, "");
}

function parseVideoUrls(body) {
  const list = [];
  if (Array.isArray(body.video_urls)) {
    for (const v of body.video_urls) {
      const s = String(v || "").trim();
      if (s) list.push(s);
    }
  }
  const single = String(body.video_url || "").trim();
  if (!list.length && single) list.push(single);
  return list;
}

async function downloadToFile(url, dir, fallbackExt) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  let ext = fallbackExt;
  if (contentType.includes("audio")) ext = ".mp3";
  if (contentType.includes("webm")) ext = ".webm";

  const filePath = path.join(dir, `${crypto.randomUUID()}${ext}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`Downloaded file was empty: ${url}`);

  await fs.writeFile(filePath, bytes);
  return filePath;
}

async function concatVideos(videoFiles, outFile, cwd) {
  if (videoFiles.length === 1) {
    try {
      await run("ffmpeg", ["-y", "-i", videoFiles[0], "-c", "copy", "-movflags", "+faststart", outFile], cwd);
      return;
    } catch {
      await run("ffmpeg", [
        "-y", "-i", videoFiles[0],
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outFile
      ], cwd);
      return;
    }
  }

  const args = ["-y"];
  for (const file of videoFiles) args.push("-i", file);

  const filter = `${videoFiles.map((_, i) => `[${i}:v:0]`).join("")}concat=n=${videoFiles.length}:v=1:a=0[v]`;
  args.push(
    "-filter_complex", filter,
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outFile
  );

  await run("ffmpeg", args, cwd);
}

async function getDurationSeconds(filePath, cwd) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ], cwd);

  const value = Number(stdout.trim());
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.round(value));
}

async function mixBackgroundAudio(videoPath, audioPath, outFile, durationSeconds, cwd) {
  const duration = Math.max(1, Math.floor(durationSeconds));

  try {
    await run("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-stream_loop", "-1",
      "-i", audioPath,
      "-filter_complex", `[1:a]volume=0.28,atrim=0:${duration},asetpts=N/SR/TB[music]`,
      "-map", "0:v:0",
      "-map", "[music]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outFile
    ], cwd);
  } catch {
    await run("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-stream_loop", "-1",
      "-i", audioPath,
      "-filter_complex", `[1:a]volume=0.28,atrim=0:${duration},asetpts=N/SR/TB[music]`,
      "-map", "0:v:0",
      "-map", "[music]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart",
      outFile
    ], cwd);
  }
}

async function uploadToSupabase(filePath, outputPath) {
  if (!supabase) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY mangler i mux-service");

  const bytes = await fs.readFile(filePath);
  const { error } = await supabase.storage
    .from(OUTPUT_BUCKET)
    .upload(outputPath, bytes, { contentType: "video/mp4", upsert: true });

  if (error) throw new Error(`Supabase upload feilet: ${error.message}`);

  const { data } = supabase.storage.from(OUTPUT_BUCKET).getPublicUrl(outputPath);
  if (!data?.publicUrl) throw new Error("Kunne ikke hente public URL fra Supabase Storage");

  return data.publicUrl;
}

function isAuthorized(req) {
  const header = String(req.header("authorization") || "");
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const token = header.slice(7).trim();
  return AUTH_SECRET && token === AUTH_SECRET;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mux", async (req, res) => {
  if (!AUTH_SECRET) return res.status(500).json({ error: "TRAILER_MUXER_SECRET mangler" });
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const videoUrls = parseVideoUrls(body);
    if (!videoUrls.length) {
      return res.status(400).json({ error: "video_url eller video_urls er påkrevd" });
    }

    const audioMode = body.audio_mode === "background" ? "background" : "music_only";
    const audioUrl = String(body.audio_url || "").trim();
    const outputPath = normalizeOutputPath(body.output_path);

    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-"));
    try {
      const videoFiles = [];
      for (const url of videoUrls) {
        videoFiles.push(await downloadToFile(url, workdir, ".mp4"));
      }

      const stitchedPath = path.join(workdir, "stitched.mp4");
      await concatVideos(videoFiles, stitchedPath, workdir);

      let finalPath = stitchedPath;
      let durationSeconds = Number(body.target_duration_seconds);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        durationSeconds = await getDurationSeconds(stitchedPath, workdir) || 8;
      }

      if (audioMode === "background" && audioUrl) {
        const audioPath = await downloadToFile(audioUrl, workdir, ".mp3");
        const mixedPath = path.join(workdir, "final.mp4");
        await mixBackgroundAudio(stitchedPath, audioPath, mixedPath, durationSeconds, workdir);
        finalPath = mixedPath;
        durationSeconds = await getDurationSeconds(finalPath, workdir) || durationSeconds;
      }

      const publicUrl = await uploadToSupabase(finalPath, outputPath);

      return res.json({
        video_url: publicUrl,
        duration_seconds: Number.isFinite(durationSeconds) ? Math.max(1, Math.round(durationSeconds)) : null,
        output_path: outputPath
      });
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mux failed";
    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Mux service listening on port ${PORT}`);
});
