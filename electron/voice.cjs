/**
 * Voice-over using the speech engine that comes with the operating system:
 * Windows - System.Speech (the voices under Settings > Time & language > Speech),
 * macOS - the built-in `say` command, Linux - espeak-ng when it is installed.
 * Nothing is sent anywhere; the spoken line is written to a temporary WAV file and read back.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CULTURE = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN', ta: 'ta-IN' };

// The text, language and voice choice reach PowerShell only as environment variables, never as code.
const WINDOWS_SPEAK = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$all = $s.GetInstalledVoices() | Where-Object { $_.Enabled }
$c = $env:MS_CULTURE
$v = $all | Where-Object { $_.VoiceInfo.Culture.Name -eq $c }
if (-not $v) { $v = $all | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $c.Substring(0,2) } }
if (-not $v) { if ($c -notlike 'en*') { [Console]::Error.Write('NO_VOICE_FOR_LANGUAGE'); exit 3 }; $v = $all }
$g = if ($env:MS_GENDER -eq 'male') { 'Male' } else { 'Female' }
$pick = $v | Where-Object { $_.VoiceInfo.Gender.ToString() -eq $g } | Select-Object -First 1
if (-not $pick) { $pick = $v | Select-Object -First 1 }
$s.SelectVoice($pick.VoiceInfo.Name)
$s.SetOutputToWaveFile($env:MS_OUT)
$s.Speak($env:MS_TEXT)
$s.Dispose()
`;
const WINDOWS_LIST = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = $_.VoiceInfo.Gender.ToString() } } | ConvertTo-Json -Compress
`;

const run = (file, args, env) =>
  new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
const powershell = (script, env) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], env);

async function speak(text, opts = {}) {
  const line = String(text || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 600);
  if (!line) return { ok: false, error: 'Nothing to say.' };
  const lang = CULTURE[opts.lang] ? opts.lang : 'en';
  const gender = opts.gender === 'male' ? 'male' : 'female';
  const out = path.join(os.tmpdir(), `ms-voice-${crypto.randomBytes(8).toString('hex')}.wav`);
  try {
    let r;
    if (process.platform === 'win32') r = await powershell(WINDOWS_SPEAK, { MS_TEXT: line, MS_CULTURE: CULTURE[lang], MS_GENDER: gender, MS_OUT: out });
    else if (process.platform === 'darwin') r = await run('say', ['--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, '--', line]);
    else r = await run('espeak-ng', ['-v', lang === 'en' ? 'en' : lang, '-w', out, '--', line]);
    if (r.stderr.includes('NO_VOICE_FOR_LANGUAGE')) return { ok: false, error: `No ${lang.toUpperCase()} voice is installed on this PC. Add it under Windows Settings > Time & language > Speech.` };
    if (r.err || !fs.existsSync(out)) return { ok: false, error: 'This computer has no usable speech engine.' };
    const buf = fs.readFileSync(out);
    return { ok: true, wav: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

async function voices() {
  if (process.platform !== 'win32') return { ok: true, voices: [] };
  const r = await powershell(WINDOWS_LIST, {});
  if (r.err) return { ok: false, error: 'Could not read the installed voices.' };
  try {
    const j = JSON.parse(r.stdout || '[]');
    return { ok: true, voices: Array.isArray(j) ? j : [j] };
  } catch {
    return { ok: true, voices: [] };
  }
}

module.exports = { speak, voices, CULTURE };
