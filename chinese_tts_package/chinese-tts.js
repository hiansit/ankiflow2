/**
 * ChineseTTS - 注音符号・漢語拼音（ピンイン）Web Speech API 統合読み上げライブラリ
 * 
 * 特徴:
 * 1. Web Speech APIが直接読めない「注音符号」および「ピンイン」を、音響解析で校正された最適な代表漢字に変換して発声
 * 2. ピンインは声調記号付き（nǐ hǎo）、数字付き（ni3 hao3）の両方の入力形式を自動サポート
 * 3. 純粋な Vanilla JavaScript (ES Modules)。ビルド不要、GitHub Pages 等でそのまま動作
 */
// 台湾華語・常用音節および軽声のビルトイン補完マッピング
const BUILTIN_ZHUYIN_SUPPLEMENT = {
  // 常用欠落音節
  'ㄉㄚˋ': '大',
  'ㄉㄨㄛ': '多',
  'ㄉㄚ': '搭',
  // 常用軽声（先頭˙付きおよび˙なしの両方に対応）
  '˙ㄇㄣ': '們', 'ㄇㄣ': '們',
  '˙ㄇㄜ': '麼', 'ㄇㄜ': '麼',
  '˙ㄗ': '子',
  '˙ㄕ': '是',
  '˙ㄉㄜ': '的', 'ㄉㄜ': '的',
  '˙ㄌㄜ': '了', 'ㄌㄜ': '了',
  '˙ㄋㄜ': '呢', 'ㄋㄜ': '呢',
  '˙ㄅㄚ': '吧', 'ㄅㄚ': '吧',
  '˙ㄇㄚ': '嗎', 'ㄇㄚ': '嗎',
  '˙ㄍㄜ': '個',
  '˙ㄉㄠ': '到',
  '˙ㄕㄤ': '上',
  '˙ㄒㄧㄚ': '下',
  '˙ㄌㄧ': '裏'
};

const BUILTIN_PINYIN_SUPPLEMENT = {
  // 常用欠落音節
  'dà': '大', 'da4': '大',
  'duō': '多', 'duo1': '多',
  'dā': '搭', 'da1': '搭',
  // 常用軽声（数字表記・声調なし両対応）
  'men': '們', 'men5': '們',
  'me': '麼', 'me5': '麼',
  'zi': '子', 'zi5': '子',
  'shi': '是', 'shi5': '是',
  'de': '的', 'de5': '的',
  'le': '了', 'le5': '了',
  'ne': '呢', 'ne5': '呢',
  'ba': '吧', 'ba5': '吧',
  'ma': '嗎', 'ma5': '嗎',
  'ge': '個', 'ge5': '個',
  'dao': '到', 'dao5': '到',
  'shang': '上', 'shang5': '上',
  'xia': '下', 'xia5': '下',
  'li': '裏', 'li5': '裏'
};

class ChineseTTS {
  constructor() {
    this.zhuyinMapping = null;
    this.pinyinMapping = null;
    this.isInitialized = false;
  }

  /**
   * マッピングJSONをロードして初期化する
   * @param {Object} paths - JSONファイルのパス設定
   * @param {string} paths.zhuyinUrl - 注音マッピングJSONのURL (デフォルト: './zhuyin_mapping.json')
   * @param {string} paths.pinyinUrl - ピンインマッピングJSONのURL (デフォルト: './pinyin_mapping.json')
   */
  async init({ zhuyinUrl = './zhuyin_mapping.json', pinyinUrl = './pinyin_mapping.json' } = {}) {
    if (this.isInitialized) return;

    try {
      const [zhuyinRes, pinyinRes] = await Promise.all([
        fetch(zhuyinUrl),
        fetch(pinyinUrl)
      ]);

      if (!zhuyinRes.ok) throw new Error(`Failed to load zhuyin mapping: ${zhuyinRes.statusText}`);
      if (!pinyinRes.ok) throw new Error(`Failed to load pinyin mapping: ${pinyinRes.statusText}`);

      this.zhuyinMapping = await zhuyinRes.json();
      this.pinyinMapping = await pinyinRes.json();
      this.isInitialized = true;
      console.log('ChineseTTS: Successfully initialized Zhuyin and Pinyin datasets.');
    } catch (error) {
      console.error('ChineseTTS: Initialization error:', error);
      throw error;
    }
  }

  /**
   * 注音トークンを漢字に変換（マッピング・補完辞書・軽声除去・フォールバック対応）
   */
  lookupZhuyinToken(token) {
    if (!token) return '';
    // 1. ロード済みマッピング
    if (this.zhuyinMapping && this.zhuyinMapping[token]) {
      return this.zhuyinMapping[token];
    }
    // 2. ビルトイン補完辞書
    if (BUILTIN_ZHUYIN_SUPPLEMENT[token]) {
      return BUILTIN_ZHUYIN_SUPPLEMENT[token];
    }
    // 3. 軽声記号 '˙' がある場合、除去して検索
    if (token.startsWith('˙')) {
      const withoutLight = token.slice(1);
      if (this.zhuyinMapping && this.zhuyinMapping[withoutLight]) {
        return this.zhuyinMapping[withoutLight];
      }
      if (BUILTIN_ZHUYIN_SUPPLEMENT[withoutLight]) {
        return BUILTIN_ZHUYIN_SUPPLEMENT[withoutLight];
      }
      const tones = ['ˊ', 'ˇ', 'ˋ'];
      for (const t of tones) {
        if (this.zhuyinMapping && this.zhuyinMapping[withoutLight + t]) {
          return this.zhuyinMapping[withoutLight + t];
        }
      }
    }
    // 4. 声調記号がない場合、声調付きをフォールバック検索
    const tones = ['ˊ', 'ˇ', 'ˋ'];
    for (const t of tones) {
      if (this.zhuyinMapping && this.zhuyinMapping[token + t]) {
        return this.zhuyinMapping[token + t];
      }
    }
    return null;
  }

  /**
   * ピンイントークンを漢字に変換（マッピング・補完辞書・軽声番号・フォールバック対応）
   */
  lookupPinyinToken(token) {
    if (!token) return '';
    const clean = token.toLowerCase();

    // 1. ロード済みマッピング
    if (this.pinyinMapping && this.pinyinMapping[clean]) {
      return this.pinyinMapping[clean];
    }
    // 2. ビルトイン補完辞書
    if (BUILTIN_PINYIN_SUPPLEMENT[clean]) {
      return BUILTIN_PINYIN_SUPPLEMENT[clean];
    }
    // 3. 軽声（末尾5）を試す
    if (this.pinyinMapping && this.pinyinMapping[`${clean}5`]) {
      return this.pinyinMapping[`${clean}5`];
    }
    if (BUILTIN_PINYIN_SUPPLEMENT[`${clean}5`]) {
      return BUILTIN_PINYIN_SUPPLEMENT[`${clean}5`];
    }
    // 4. 数字なしの場合、各声調番号（1〜4）をフォールバック検索
    if (/^[a-z]+$/.test(clean)) {
      for (let i = 1; i <= 4; i++) {
        if (this.pinyinMapping && this.pinyinMapping[`${clean}${i}`]) {
          return this.pinyinMapping[`${clean}${i}`];
        }
      }
    }
    return null;
  }

  /**
   * 注音符号を漢字に変換する
   * @param {string} zhuyinStr - 注音符号の文字列（例: "ㄋㄧˇ ㄏㄠˇ", "ㄋㄧˇㄏㄠˇ"）
   * @returns {string} 変換後の漢字文字列
   */
  convertZhuyin(zhuyinStr) {
    if (!zhuyinStr) return '';

    const tokens = zhuyinStr.trim().split(/[\s,，、・;；:：\-\_]+/);
    const result = [];

    for (const token of tokens) {
      if (!token) continue;
      const matched = this.lookupZhuyinToken(token);
      if (matched) {
        result.push(matched);
      } else {
        const subTokens = this.tokenizeZhuyin(token);
        if (subTokens.length > 0) {
          for (const sub of subTokens) {
            result.push(this.lookupZhuyinToken(sub) || sub);
          }
        } else {
          result.push(token);
        }
      }
    }
    return result.join('');
  }

  /**
   * ピンインを漢字に変換する
   * @param {string} pinyinStr - ピンイン文字列（例: "nǐ hǎo", "ni3 hao3", "hua2"）
   * @returns {string} 変換後の漢字文字列
   */
  convertPinyin(pinyinStr) {
    if (!pinyinStr) return '';

    // スペース、カンマ、ハイフン等で分割
    const tokens = pinyinStr.trim().split(/[\s,，、・;；:：\-\_]+/);
    const result = [];

    for (let token of tokens) {
      if (!token) continue;
      const matched = this.lookupPinyinToken(token);
      if (matched) {
        result.push(matched);
      } else {
        result.push(token);
      }
    }
    return result.join('');
  }

  /**
   * 文字列を自動判定して代表漢字に変換する
   * @param {string} inputStr - 注音またはピンイン、漢字の文字列
   * @returns {string} 変換後の漢字文字列
   */
  convert(inputStr) {
    if (!inputStr) return '';
    // 注音文字（ㄅ〜ㄦ）または声調記号が含まれているか判定
    if (/[\u3105-\u312F\u31A0-\u31BF˙ˊˇˋ]/.test(inputStr)) {
      return this.convertZhuyin(inputStr);
    }
    // アルファベットまたは声調付き母音が含まれていればピンインとして処理
    if (/[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(inputStr)) {
      return this.convertPinyin(inputStr);
    }
    // それ以外（漢字など）はそのまま
    return inputStr;
  }

  /**
   * 注音・ピンイン・漢字を発音する
   * @param {string} text - 発音させたい注音またはピンイン文字列
   * @param {Object} options - 発音オプション (voice, lang, rate, pitch, volume)
   * @returns {Promise<void>} 読み上げ完了時に解決されるPromise
   */
  async speak(text, options = {}) {
    if (!this.isInitialized) {
      try {
        await this.init();
      } catch (err) {
        console.warn('ChineseTTS: init failed or deferred, will proceed with built-in mappings:', err);
      }
    }

    const textToSpeak = this.convert(text);
    if (!textToSpeak) return;

    return new Promise((resolve) => {
      // 直前の発声を安全にクリア
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch (e) {}

        // Chromiumの cancel -> speak 競合バグを回避するため極小の遅延
        setTimeout(() => {
          try {
            const utterance = new SpeechSynthesisUtterance(textToSpeak);

            if (options.voice) {
              utterance.voice = options.voice;
            }
            // 重要: langを明示指定（指定しないとブラウザ既定言語 ja-JP で読まれ沈黙する）
            utterance.lang = options.lang || (options.voice ? options.voice.lang : 'zh-TW');

            if (options.rate !== undefined) utterance.rate = options.rate;
            if (options.pitch !== undefined) utterance.pitch = options.pitch;
            if (options.volume !== undefined) utterance.volume = options.volume;

            utterance.onend = () => resolve();
            utterance.onerror = (event) => {
              if (event.error !== 'interrupted' && event.error !== 'canceled') {
                console.warn('ChineseTTS: SpeechSynthesis event error:', event);
              }
              resolve();
            };

            window.speechSynthesis.speak(utterance);
          } catch (err) {
            console.warn('ChineseTTS: speak invocation failed:', err);
            resolve();
          }
        }, 20);
      } else {
        resolve();
      }
    });
  }

  /**
   * 注音文字列を個別音節にトークナイズする
   */
  tokenizeZhuyin(str) {
    const tokens = [];
    let i = 0;
    const zhuyinChars = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄧㄨㄩㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ';
    const tones = 'ˊˇˋ';
    const lightTone = '˙';

    while (i < str.length) {
      let current = '';
      if (str[i] === lightTone) {
        current += str[i];
        i++;
      }
      while (i < str.length && zhuyinChars.includes(str[i])) {
        current += str[i];
        i++;
      }
      if (i < str.length && tones.includes(str[i])) {
        current += str[i];
        i++;
      }
      if (current) {
        tokens.push(current);
      } else {
        tokens.push(str[i]);
        i++;
      }
    }
    return tokens;
  }

  /**
   * ブラウザから利用可能な中国語音声リストを取得する
   * @returns {Promise<SpeechSynthesisVoice[]>}
   */
  static getChineseVoices() {
    return new Promise((resolve) => {
      let voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        resolve(ChineseTTS.filterVoices(voices));
        return;
      }
      window.speechSynthesis.onvoiceschanged = () => {
        voices = window.speechSynthesis.getVoices();
        resolve(ChineseTTS.filterVoices(voices));
      };
    });
  }

  static filterVoices(voices) {
    return voices.filter(v => {
      const lang = v.lang.toLowerCase();
      return lang.startsWith('zh') || lang.includes('chinese');
    });
  }
}

if (typeof window !== 'undefined') {
  window.ChineseTTS = ChineseTTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChineseTTS };
}

