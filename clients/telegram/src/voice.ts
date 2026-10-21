/**
 * Voice notes, audio and video notes the owner sends, as words midna reads.
 *
 * una — Justin's own speech model, a server on his network (on midna's
 * host for now) — transcribes them: POST /v1/dictations, without its
 * English-only cleanup pass. It reads OGG/Opus (a voice note), WAV, FLAC
 * and MP3 as they are; anything else (a video note's MP4, an m4a) goes
 * through ffmpeg to 16 kHz mono WAV first, when ffmpeg is there (it isn't
 * on the Jetson). una that isn't running, says no (503 while it trains),
 * or takes longer than UNA_TIMEOUT_MS leaves the note untranscribed: it
 * still reaches midna, as audio, with why. Nothing else transcribes: the
 * Jetson has no other speech-to-text, nor room for one beside una.
 *
 * una has no Korean+English mode yet: by default it hears English, so
 * Korean comes back translated; `language: "ko"` keeps Korean but writes
 * English words in Hangul. Every note also becomes an entry in una's
 * history, labelled as the Telegram bridge's.
 */

/** How long una gets before the note goes on without its words. */
export const UNA_TIMEOUT_MS = 60_000;

/** Where una answers, unless the bridge's settings or UNA_URL say otherwise. */
export const UNA_URL = "http://127.0.0.1:8100";

export type Heard = { ok: true; text: string; by: string } | { ok: false; why: string };

/** What the bridge says before the words: "[voice note 0:42, transcribed by una]". */
export function marker(kind: string, seconds: number | undefined, heard: Heard): string {
  const s = Math.round(seconds ?? 0);
  const length = s ? ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
  return heard.ok ? `[${kind}${length}, transcribed by ${heard.by}]` : `[${kind}${length}, not transcribed: ${heard.why}]`;
}

const READABLE = /^audio\/(ogg|opus|wav|x-wav|wave|flac|x-flac|mpeg|mp3)$/;

/** The bytes as something una can read: as they are, or as WAV by way of ffmpeg. */
async function readable(audio: Uint8Array<ArrayBuffer>, mime: string): Promise<{ data: Uint8Array<ArrayBuffer>; mime: string; name: string } | string> {
  if (READABLE.test(mime)) return { data: audio, mime, name: mime.includes("ogg") || mime.includes("opus") ? "voice.ogg" : "audio" };
  const ffmpeg = Bun.which("ffmpeg", { PATH: process.env.PATH ?? "" });
  if (!ffmpeg) return `una can't read ${mime} and there's no ffmpeg here to convert it`;
  const p = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], { stdin: audio, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
  return code === 0 && out.byteLength > 44 ? { data: new Uint8Array(out), mime: "audio/wav", name: "audio.wav" } : `ffmpeg couldn't turn the ${mime} into audio una reads`;
}

/**
 * The words in a recording, by una. `id` is the recording's stable id
 * (Telegram's file_unique_id): una answers a retry with the same id from
 * what it stored, rather than transcribing it twice.
 */
export async function transcribe(
  audio: Uint8Array<ArrayBuffer>,
  file: { mime: string; id: string },
  opts: { una?: string; language?: string; timeoutMs?: number } = {},
): Promise<Heard> {
  const una = (opts.una ?? process.env.UNA_URL ?? UNA_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? UNA_TIMEOUT_MS;
  const input = await readable(audio, file.mime.toLowerCase()).catch((err: Error) => `converting it failed: ${err.message}`);
  if (typeof input === "string") return { ok: false, why: input };
  const form = new FormData();
  form.set("audio", new Blob([input.data], { type: input.mime }), input.name);
  form.set("clean", "false");
  form.set("app_name", "telegram");
  form.set("client", "midna-telegram-bridge");
  form.set("utterance_id", `tg-${file.id}`);
  if (opts.language) form.set("language", opts.language);
  try {
    const res = await fetch(`${una}/v1/dictations`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { code?: string; message?: string } };
    if (!res.ok) return { ok: false, why: `una said ${res.status}${body.error?.message ? `: ${body.error.message}` : ""}` };
    const text = body.text?.trim() ?? "";
    return text ? { ok: true, text, by: "una" } : { ok: false, why: "una heard no words in it" };
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") return { ok: false, why: `una didn't answer within ${Math.round(timeoutMs / 1000)} s` };
    return { ok: false, why: `una isn't reachable (${e.message})` };
  }
}
