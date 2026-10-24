// Spoken notes: a thin state machine over the browser's SpeechRecognition, plus a conservative
// rewrite of spoken link words. Nothing here guesses a repository from a project name.

export const VOICE_TEXT = {
  unsupported: '這個瀏覽器不支援語音輸入。請改用 Chrome／Edge，或直接貼上逐字稿。',
  denied: '麥克風權限被拒絕。請在瀏覽器網址列旁的權限設定允許麥克風，或直接貼上逐字稿。',
  'no-speech': '沒有聽到聲音，請再試一次。',
  network: '語音辨識服務連不上（瀏覽器的辨識需要網路），請改貼逐字稿。',
  error: '語音辨識中斷，已保留目前的文字。',
  privacy: '使用 Chrome／Edge 的語音輸入時，聲音會送到瀏覽器廠商的伺服器辨識。不想送出就直接貼上逐字稿。',
  urlWarning: '語音辨識常把網址聽錯（大小寫、連字號、斜線）。送出前請對照原始連結確認每一個候選。',
};

export function recognizerClass(scope = globalThis) {
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

// states: idle -> listening -> idle (stop keeps the text, cancel drops this session's text).
export function createVoice({ Recognizer = recognizerClass(), lang = 'zh-TW', onText = () => {}, onState = () => {} } = {}) {
  if (!Recognizer) return { supported: false, start() { onState('error', 'unsupported'); }, stop() {}, cancel() {} };
  let rec = null, finalText = '', cancelled = false, state = 'idle';
  const set = (s, why) => { state = s; onState(s, why); };
  return {
    supported: true,
    get state() { return state; },
    start(base = '') {
      if (state === 'listening') return;
      finalText = base; cancelled = false;
      rec = new Recognizer();
      rec.lang = lang; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (ev) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
        }
        if (!cancelled) onText(finalText + interim, false);
      };
      rec.onerror = (ev) => {
        const code = ev && ev.error;
        const why = code === 'not-allowed' || code === 'service-not-allowed' ? 'denied'
          : code === 'no-speech' ? 'no-speech' : code === 'network' ? 'network' : code === 'aborted' ? null : 'error';
        if (why) set('error', why);
      };
      rec.onend = () => { if (!cancelled) onText(finalText, true); if (state !== 'error') set('idle'); rec = null; };
      try { rec.start(); set('listening'); } catch { set('error', 'error'); }
    },
    stop() { if (rec) rec.stop(); },
    cancel() { cancelled = true; if (rec) rec.abort(); set('idle', 'cancelled'); },
  };
}

// "github 點 com 斜線 owner 斜線 repo" -> "github.com/owner/repo". Only rewrites words next to
// ASCII link text, and the person sees and confirms the result before anything is extracted.
export function normalizeSpokenLinks(text) {
  return String(text)
    .replace(/git\s*hub/gi, 'github')
    .replace(/\s*(?:點|dot)\s*(?=(?:com|net|io|md)\b)/gi, '.')
    .replace(/\s*(?:斜線|slash)\s*/gi, '/')
    .replace(/\s*(?:減號|dash|hyphen)\s*/gi, '-')
    .replace(/\s*(?:底線|underscore)\s*/gi, '_')
    .replace(/(github\.com(?:\/[A-Za-z0-9._-]+)*)\s+\/\s*/gi, '$1/')
    .replace(/(https?:)\s*\/\s*\/\s*/gi, '$1//');
}
