/**
 * SpeechService - Web Speech API & ChineseTTS（注音/ピンイン/台湾華語）統合音声読み上げマネージャー
 */
class SpeechService {
  constructor() {
    this.chineseTts = null;
    this.isInitialized = false;
    this.availableVoices = [];
    this.twVoice = null;
    this.cnVoice = null;
    this.jaVoice = null;
    this.enVoice = null;

    // 自動読み上げ設定（localStorage永続化）
    this.isAutoSpeakEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('learning_rank_auto_speak') === 'true';
    this.speechRate = typeof localStorage !== 'undefined' ? parseFloat(localStorage.getItem('learning_rank_speech_rate') || '1.0') : 1.0;
  }

  /**
   * 音声エンジン・ChineseTTSの初期化
   */
  async init() {
    if (this.isInitialized) return;

    // 1. ChineseTTS 初期化
    const ChineseTTSClass = (typeof window !== 'undefined' && window.ChineseTTS) || (typeof ChineseTTS !== 'undefined' ? ChineseTTS : null);
    if (ChineseTTSClass) {
      this.chineseTts = new ChineseTTSClass();
      try {
        await this.chineseTts.init({
          zhuyinUrl: 'chinese_tts_package/zhuyin_mapping.json',
          pinyinUrl: 'chinese_tts_package/pinyin_mapping.json'
        });
        console.log('SpeechService: ChineseTTS mapping loaded.');
      } catch (err) {
        console.warn('SpeechService: Could not load ChineseTTS mapping from root, trying subfolder fallback.', err);
        try {
          await this.chineseTts.init({
            zhuyinUrl: './chinese_tts_package/zhuyin_mapping.json',
            pinyinUrl: './chinese_tts_package/pinyin_mapping.json'
          });
        } catch (e2) {
          console.warn('SpeechService: ChineseTTS JSON load failed, will use built-in mappings:', e2);
        }
      }
    }

    // 2. Web Speech API 音声リスト取得
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      await this.loadBrowserVoices();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => this.loadBrowserVoices();
      }
    }

    this.isInitialized = true;
  }

  /**
   * ブラウザ内の音声一覧を取得し、各言語の最適音声を割り当て
   */
  async loadBrowserVoices() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      await new Promise(resolve => {
        const handler = () => {
          voices = window.speechSynthesis.getVoices();
          resolve();
        };
        window.speechSynthesis.onvoiceschanged = handler;
        setTimeout(handler, 500); // タイムアウトフォールバック
      });
    }

    this.availableVoices = voices;

    // 中国語普通話（zh-CN）
    this.cnVoice = voices.find(v => {
      const l = v.lang.toLowerCase();
      return l === 'zh-cn' || l.includes('zh_cn') || l.includes('mandarin') || l.includes('china') || l.includes('chinese_china');
    }) || voices.find(v => v.lang.toLowerCase().startsWith('zh')) || null;

    // 台湾華語（zh-TW）優先検出（見つからない場合はcnVoiceをフォールバックに採用）
    this.twVoice = voices.find(v => {
      const l = v.lang.toLowerCase();
      return l === 'zh-tw' || l.includes('zh_tw') || l.includes('taiwan') || l === 'zh-hk' || l.includes('chinese_taiwan');
    }) || this.cnVoice || null;

    // 日本語（ja-JP）
    this.jaVoice = voices.find(v => v.lang.toLowerCase().startsWith('ja')) || null;

    // 英語（en-US）
    this.enVoice = voices.find(v => {
      const l = v.lang.toLowerCase();
      return l === 'en-us' || l.includes('en_us');
    }) || voices.find(v => v.lang.toLowerCase().startsWith('en')) || null;

    console.log('SpeechService: Voices loaded -', {
      zhTW: this.twVoice?.name || 'none',
      zhCN: this.cnVoice?.name || 'none',
      ja: this.jaVoice?.name || 'none',
      en: this.enVoice?.name || 'none'
    });
  }

  /**
   * テキストの言語・形式を自動判定
   * @param {string} text 
   * @param {string} preferredLang - 'auto' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'en-US' | 'zhuyin' | 'pinyin'
   */
  detectLanguage(text, preferredLang = 'auto') {
    if (!text) return 'ja-JP';
    if (preferredLang && preferredLang !== 'auto') return preferredLang;

    const trimmed = text.trim();

    // 1. 注音符号（ㄅ〜ㄦ、声調記号含む）
    if (/[\u3105-\u312F\u31A0-\u31BF˙ˊˇˋ]/.test(trimmed)) {
      return 'zhuyin';
    }

    // 2. 声調記号付きピンイン（āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ）
    if (/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(trimmed)) {
      return 'pinyin';
    }

    // 3. 数字付きピンイン（例: ni3 hao3, hua2, ma5）
    if (/^[a-zA-ZüÜ]+\d(\s+[a-zA-ZüÜ]+\d)*$/.test(trimmed)) {
      return 'pinyin';
    }

    // 4. 日本語（ひらがな・カタカナを含む）
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(trimmed)) {
      return 'ja-JP';
    }

    // 5. 英語のみ（アルファベット、数字、基本記号）
    if (/^[a-zA-Z0-9\s,.'\"!?\-_/()]+$/.test(trimmed)) {
      return 'en-US';
    }

    // 6. 漢字のみ
    if (/^[\u4E00-\u9FFF\s,、。！？]+$/.test(trimmed)) {
      // 漢字のみの場合は台湾華語（zh-TW）をデフォルトとする
      return 'zh-TW';
    }

    return 'ja-JP';
  }

  /**
   * 音声読み上げの実行
   * @param {string} text - 発音させたいテキスト
   * @param {Object} options - 発音オプション
   */
  async speak(text, options = {}) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      console.warn('SpeechService: SpeechSynthesis is not supported in this environment.');
      return;
    }

    if (!text || !text.trim()) return;

    // 発音停止
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}

    const targetLang = this.detectLanguage(text, options.lang || 'auto');
    const rate = options.rate !== undefined ? options.rate : this.speechRate;
    const pitch = options.pitch !== undefined ? options.pitch : 1.0;
    const volume = options.volume !== undefined ? options.volume : 1.0;

    // A. 注音符号またはピンイン（ChineseTTS で代表漢字に変換して発声）
    if (targetLang === 'zhuyin' || targetLang === 'pinyin') {
      const voiceToUse = this.twVoice || this.cnVoice || null;
      const langCode = this.twVoice ? 'zh-TW' : (this.cnVoice ? 'zh-CN' : 'zh-TW');

      if (this.chineseTts) {
        try {
          await this.chineseTts.speak(text, {
            voice: voiceToUse,
            lang: langCode,
            rate,
            pitch,
            volume
          });
          return;
        } catch (err) {
          console.warn('SpeechService: ChineseTTS speak failed, falling back to standard SpeechSynthesis:', err);
        }
      }
      return this.speakStandard(text, voiceToUse, langCode, rate, pitch, volume);
    }

    // B. 台湾華語（zh-TW）
    if (targetLang === 'zh-TW' || targetLang === 'zh') {
      const voiceToUse = this.twVoice || this.cnVoice || null;
      const langCode = this.twVoice ? 'zh-TW' : (this.cnVoice ? 'zh-CN' : 'zh-TW');

      if (this.chineseTts) {
        try {
          // ChineseTTS.convert は漢字であればそのまま通し、注音・ピンイン混じりでも代表漢字化
          await this.chineseTts.speak(text, {
            voice: voiceToUse,
            lang: langCode,
            rate,
            pitch,
            volume
          });
          return;
        } catch (err) {
          console.warn('SpeechService: ChineseTTS speak failed:', err);
        }
      }
      return this.speakStandard(text, voiceToUse, langCode, rate, pitch, volume);
    }

    // C. 中国語普通話（zh-CN）
    if (targetLang === 'zh-CN') {
      return this.speakStandard(text, this.cnVoice, 'zh-CN', rate, pitch, volume);
    }

    // D. 英語（en-US）
    if (targetLang === 'en-US' || targetLang === 'en') {
      return this.speakStandard(text, this.enVoice, 'en-US', rate, pitch, volume);
    }

    // E. 日本語（ja-JP）
    return this.speakStandard(text, this.jaVoice, 'ja-JP', rate, pitch, volume);
  }

  /**
   * 標準 Web Speech API による発声
   */
  speakStandard(text, voice, langCode, rate = 1.0, pitch = 1.0, volume = 1.0) {
    return new Promise((resolve) => {
      // cancel直後の競合対策タイマー
      setTimeout(() => {
        try {
          const utterance = new SpeechSynthesisUtterance(text);
          if (voice) {
            utterance.voice = voice;
          }
          utterance.lang = langCode;
          utterance.rate = rate;
          utterance.pitch = pitch;
          utterance.volume = volume;

          utterance.onend = () => resolve();
          utterance.onerror = (e) => {
            if (e.error !== 'interrupted' && e.error !== 'canceled') {
              console.warn('SpeechSynthesis standard error:', e);
            }
            resolve();
          };

          window.speechSynthesis.speak(utterance);
        } catch (err) {
          console.warn('SpeechSynthesis speak error:', err);
          resolve();
        }
      }, 20);
    });
  }

  /**
   * 自動読み上げのトグル
   */
  setAutoSpeak(enabled) {
    this.isAutoSpeakEnabled = !!enabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('learning_rank_auto_speak', String(this.isAutoSpeakEnabled));
    }
  }

  /**
   * 発音速度の変更
   */
  setRate(rate) {
    this.speechRate = rate;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('learning_rank_speech_rate', String(rate));
    }
  }
}

if (typeof window !== 'undefined') {
  window.SpeechService = SpeechService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpeechService;
}
