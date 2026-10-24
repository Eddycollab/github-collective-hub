// Phase 2: transcribing uploaded audio/video files. Only the adapter contract exists; no provider is
// wired in, so nothing in the UI offers an upload. See docs/asr-adapter.md before adding one.
//
// An adapter is { id, label, available(): Promise<{ok, reason}>, transcribe(file, {lang, signal}):
//   Promise<{ text, segments?: [{start, end, text}], provider, model? }> }.
// It must never hold a provider secret in the page (the page stores a GitHub token and loads no
// third-party JS); a real adapter would hand the file to the user's own backend or Actions job.

export class NoProviderAdapter {
  constructor() { this.id = 'none'; this.label = '尚未設定語音轉錄服務'; }
  async available() { return { ok: false, reason: '錄音檔轉逐字稿是第二階段功能，尚未設定提供者、費用與金鑰存放方式。現在請貼上逐字稿或用麥克風口述。' }; }
  async transcribe() { throw new Error('no transcription provider configured'); }
}

export function currentAdapter() { return new NoProviderAdapter(); }
