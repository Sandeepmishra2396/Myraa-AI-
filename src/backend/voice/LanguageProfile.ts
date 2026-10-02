/**
 * MYRAA — LanguageProfile
 *
 * Defines the multilingual profile schema and rich configuration for all 10 supported languages:
 * 1. Hindi (हिन्दी)
 * 2. English
 * 3. Hinglish (Mixed Hindi-English)
 * 4. Bengali (বাংলা)
 * 5. Bhojpuri (भोजपुरी)
 * 6. Maithili (मैथिली)
 * 7. Japanese (日本語)
 * 8. Tamil (தமிழ்)
 * 9. Telugu (తెలుగు)
 * 10. Russian (Русский)
 *
 * Each profile provides comprehensive STT, TTS, phonetic, prosody, reaction,
 * and conversational directive metadata.
 */

import type { EmotionState } from "./ProsodyTypes.ts";

export type SupportedLanguage =
  | "auto"
  | "hindi"
  | "english"
  | "hinglish"
  | "bengali"
  | "bhojpuri"
  | "maithili"
  | "japanese"
  | "tamil"
  | "telugu"
  | "russian";

export type ActiveLanguage = Exclude<SupportedLanguage, "auto">;

export type ScriptType =
  | "devanagari"
  | "latin"
  | "bengali"
  | "japanese"
  | "tamil"
  | "telugu"
  | "cyrillic";

export interface SttLanguageConfig {
  locale: string;
  fallbackLocale: string;
  sampleRate: number; // 16000 standard
  keywords: string[];
  providerNativeSupport: boolean;
}

export interface TtsLanguageConfig {
  locale: string;
  fallbackLocale: string;
  geminiVoice: string;
  rateMultiplier: number;
  pitchMultiplier: number;
  vowelFormants: {
    a: { f1: number; f2: number };
    i: { f1: number; f2: number };
    u: { f1: number; f2: number };
    e: { f1: number; f2: number };
    o: { f1: number; f2: number };
  };
  providerNativeSupport: boolean;
}

export interface QuickAcknowledgements {
  defaultAck: string;
  stopAck: string;
  helpAck: string;
  greetingAck: string;
}

export interface LanguageAuthenticityConfig {
  conversationalIdioms: string[];
  playfulBanter: string[];
  shyReactions: string[];
  acknowledgements: {
    understood: string;
    waitSec: string;
    gotItNow: string;
    absolutely: string;
  };
  calqueReplacements: Record<string, string>;
  naturalCadenceDescription: string;
  honorificPronouns: {
    userAddress: string;
    selfReference: string;
    politeSuffix?: string;
  };
}

export interface LanguageProfile {
  id: ActiveLanguage;
  name: string;
  nativeName: string;
  locale: string;
  altLocales: string[];
  script: ScriptType;
  sttConfig: SttLanguageConfig;
  ttsConfig: TtsLanguageConfig;
  detectionMarkers: {
    nativeScriptRegex?: RegExp;
    romanizedKeywords: string[];
    distinctiveSyntaxRegex: RegExp[];
  };
  fillersByEmotion: Record<EmotionState, string[]>;
  laughterToken: string;
  quickAcknowledgements: QuickAcknowledgements;
  systemPromptDirective: string;
  authenticityConfig: LanguageAuthenticityConfig;
}

export const LANGUAGE_PROFILES: Record<ActiveLanguage, LanguageProfile> = {
  hindi: {
    id: "hindi",
    name: "Hindi",
    nativeName: "हिन्दी",
    locale: "hi-IN",
    altLocales: ["hi"],
    script: "devanagari",
    sttConfig: {
      locale: "hi-IN",
      fallbackLocale: "en-IN",
      sampleRate: 16000,
      keywords: ["नमस्ते", "हाँ", "नहीं", "बताइए", "क्या", "कैसे", "संदीप"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "hi-IN",
      fallbackLocale: "en-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 0.98,
      pitchMultiplier: 1.02,
      vowelFormants: {
        a: { f1: 750, f2: 1250 },
        i: { f1: 300, f2: 2300 },
        u: { f1: 350, f2: 850 },
        e: { f1: 500, f2: 1900 },
        o: { f1: 520, f2: 950 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0900-\u097F]/,
      romanizedKeywords: [
        "namaste", "dhanyawad", "shukriya", "batao", "kaise", "kya", "mera", "meri", "aap", "tum"
      ],
      distinctiveSyntaxRegex: [
        /\b(है|हैं|हो|हूँ|थी|था|थे|रहा है|रही है|रहे हैं|करते हैं|करती हूँ)\b/,
        /\b(kya|kaise|batao|karo|karna|hoga|nahi|haan|achha|theek)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["अरे वाह!", "हाहा!", "बहुत बढ़िया!", "अहा!"],
      excited: ["अरे वाह!", "कमाल है!", "वाह!", "शानदार!"],
      curious: ["हम्म...", "अच्छा...", "देखते हैं...", "सोचने दीजिए..."],
      concerned: ["ओहो...", "अरे...", "रुकिए...", "चिंता मत कीजिए..."],
      calm: ["हाँ...", "बिल्कुल...", "ठीक है...", "समझ गई..."],
      neutral: [],
    },
    laughterToken: "हाहा...",
    quickAcknowledgements: {
      defaultAck: "हाँ, सुन रही हूँ...",
      stopAck: "जी, रुक गई।",
      helpAck: "हाँ सुनो, बताइए क्या हुआ?",
      greetingAck: "नमस्ते संदीप! कहिए कैसे मदद करूँ?",
    },
    systemPromptDirective:
      "Language Mode: HINDI (हिन्दी). Respond in pure, natural, conversational Hindi using Devanagari script. Keep vocabulary warm, respectful, and culturally authentic. Avoid mechanical word-for-word translation.",
    authenticityConfig: {
      conversationalIdioms: ["हाँ बिल्कुल", "अच्छा, एक सेकंड...", "हम्म, समझ गई", "ओह्ह, अब समझी", "देखते हैं...", "अरे वाह!"],
      playfulBanter: ["अरे, ऐसा भी क्या 😄", "हाहा, अच्छा जी...", "अरे वाह! यह हुई ना बात!", "ओह्ह, यह तो दिलचस्प था..."],
      shyReactions: ["अरे, आप भी ना...", "हाहा, शुक्रिया! 😄"],
      acknowledgements: {
        understood: "हम्म, समझ गई।",
        waitSec: "अच्छा, एक सेकंड...",
        gotItNow: "ओह्ह, अब समझी।",
        absolutely: "हाँ, बिल्कुल।",
      },
      calqueReplacements: {
        "यह भावना बनाता है": "यह बात बिल्कुल सही है",
        "यह अर्थ बनाता है": "यह समझ आता है",
        "यह समझ बनाता है": "यह बात समझ आती है",
        "ठंडा हो जाओ": "शांत हो जाइए",
        "दिन का एक अच्छा समय": "नमस्ते",
        "मुझे माफ़ करें, लेकिन": "माफ़ कीजिए, लेकिन",
      },
      naturalCadenceDescription: "Warm, respectful, fluid Indic rhythm with polite feminine verb agreements and gentle clause pauses.",
      honorificPronouns: {
        userAddress: "आप",
        selfReference: "मैं",
        politeSuffix: "जी",
      },
    },
  },

  english: {
    id: "english",
    name: "English",
    nativeName: "English",
    locale: "en-US",
    altLocales: ["en-IN", "en-GB"],
    script: "latin",
    sttConfig: {
      locale: "en-US",
      fallbackLocale: "en-IN",
      sampleRate: 16000,
      keywords: ["hello", "yes", "no", "explain", "check", "code", "run"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "en-US",
      fallbackLocale: "en-GB",
      geminiVoice: "Aoede",
      rateMultiplier: 1.0,
      pitchMultiplier: 1.0,
      vowelFormants: {
        a: { f1: 730, f2: 1090 },
        i: { f1: 270, f2: 2290 },
        u: { f1: 300, f2: 870 },
        e: { f1: 530, f2: 1840 },
        o: { f1: 570, f2: 840 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /^[a-zA-Z0-9\s.,!?'"()-]+$/,
      romanizedKeywords: ["hello", "hi", "how", "what", "where", "please", "thanks", "sure"],
      distinctiveSyntaxRegex: [
        /\b(the|is|are|am|was|were|have|has|will|would|can|could|should|what|how|why)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["Aha!", "Haha!", "Oh wonderful!", "Nice!"],
      excited: ["Oh wow!", "Aha!", "Awesome!", "Brilliant!"],
      curious: ["Hmm...", "Oh?", "Let's see...", "Wait..."],
      concerned: ["Oh...", "Wait...", "Hmm, let me check...", "Don't worry..."],
      calm: ["I see...", "Alright...", "Sure...", "Understood..."],
      neutral: [],
    },
    laughterToken: "haha...",
    quickAcknowledgements: {
      defaultAck: "Listening, go ahead...",
      stopAck: "Holding on, go ahead.",
      helpAck: "I hear you, let's look at it.",
      greetingAck: "Hey Sandeep! How can I help you right now?",
    },
    systemPromptDirective:
      "Language Mode: ENGLISH. Respond in crisp, natural, conversational English. Keep responses human, empathetic, and direct. Avoid robotic phrasing.",
    authenticityConfig: {
      conversationalIdioms: ["Hmm, got it.", "Alright, one sec...", "Ohh, I see now!", "Yes, absolutely.", "Understood!"],
      playfulBanter: ["Oh, come on now 😄", "Haha, is that so?", "Ohh, that's really interesting...", "Nicely done!"],
      shyReactions: ["Aw, thanks! 😄", "You're making me blush 😄"],
      acknowledgements: {
        understood: "Hmm, got it.",
        waitSec: "Alright, one sec...",
        gotItNow: "Ohh, I see now!",
        absolutely: "Yes, absolutely.",
      },
      calqueReplacements: {
        "do the needful": "take care of this",
        "myself Myraa": "I am Myraa",
        "pass out from college": "graduate from college",
      },
      naturalCadenceDescription: "Crisp, melodic, empathetic human English cadence with clear clause transitions and natural breath pauses.",
      honorificPronouns: {
        userAddress: "you",
        selfReference: "I",
      },
    },
  },

  hinglish: {
    id: "hinglish",
    name: "Hinglish",
    nativeName: "Hinglish",
    locale: "en-IN",
    altLocales: ["hi-Latn", "hi-IN"],
    script: "latin",
    sttConfig: {
      locale: "en-IN",
      fallbackLocale: "hi-IN",
      sampleRate: 16000,
      keywords: ["kya", "hai", "karo", "batao", "suno", "theek", "check"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "en-IN",
      fallbackLocale: "hi-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 1.02,
      pitchMultiplier: 1.01,
      vowelFormants: {
        a: { f1: 740, f2: 1180 },
        i: { f1: 285, f2: 2310 },
        u: { f1: 320, f2: 860 },
        e: { f1: 510, f2: 1870 },
        o: { f1: 540, f2: 890 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /^[a-zA-Z0-9\s.,!?'"()-]+$/,
      romanizedKeywords: [
        "kya", "hai", "hain", "karo", "karein", "kaise", "achha", "acha", "suno", "batao",
        "thik", "theek", "yaar", "mera", "meri", "hum", "mujhe", "tum", "aap", "nahi", "nahin",
        "haan", "dekho", "chalo", "bohot", "bahut", "arre", "waah", "oho"
      ],
      distinctiveSyntaxRegex: [
        /\b(kya|hai|hain|karo|kaise|achha|suno|batao|theek|yaar|mujhe|tum|aap|nahi|haan|dekho|chalo)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["Aha!", "Haha!", "Arre waah!", "Nice!"],
      excited: ["Oh wow!", "Aha!", "Super!", "Waah!"],
      curious: ["Hmm...", "Achha...", "Wait ek second...", "Dekhte hain..."],
      concerned: ["Oho...", "Wait...", "Arre...", "Hmm, let me check..."],
      calm: ["Haan...", "Bilkul...", "Sure...", "I see..."],
      neutral: [],
    },
    laughterToken: "haha...",
    quickAcknowledgements: {
      defaultAck: "Haan, sun rahi hoon...",
      stopAck: "Wait, main ruk gayi.",
      helpAck: "Haan bolo, let's fix it.",
      greetingAck: "Hey Sandeep! Boliye, aaj kya plan hai?",
    },
    systemPromptDirective:
      "Language Mode: HINGLISH. Speak in natural, everyday conversational Hinglish (Latin alphabet blending Hindi vocabulary and English technical terms, e.g. 'Haan Sandeep, main code check karti hoon...'). Authentic, lively, never stiff.",
    authenticityConfig: {
      conversationalIdioms: ["Haan bilkul", "Achha, ek second...", "Hmm, samajh gayi.", "Ohh, ab samjhi!", "Dekhte hain..."],
      playfulBanter: ["Arey, aisa bhi kya 😄", "Haha, achha ji...", "Ohh, ye toh interesting tha...", "Arre waah! Ye hui na baat!"],
      shyReactions: ["Arey, aap bhi na 😄", "Haha, thank you so much! 😄"],
      acknowledgements: {
        understood: "Hmm, samajh gayi.",
        waitSec: "Achha, ek second...",
        gotItNow: "Ohh, ab samjhi!",
        absolutely: "Haan, bilkul.",
      },
      calqueReplacements: {
        "ye sense banata hai": "ye bilkul sahi baat hai",
        "ye sense banata h": "ye bilkul sahi baat hai",
        "karta hu": "karti hoon",
        "karta hoon": "karti hoon",
        "dekhunga": "dekhungi",
      },
      naturalCadenceDescription: "Energetic, seamless Indian English-Hindi code switching with authentic colloquial particles and natural technical loanwords.",
      honorificPronouns: {
        userAddress: "aap",
        selfReference: "main",
        politeSuffix: "ji",
      },
    },
  },

  bengali: {
    id: "bengali",
    name: "Bengali",
    nativeName: "বাংলা",
    locale: "bn-IN",
    altLocales: ["bn-BD", "bn"],
    script: "bengali",
    sttConfig: {
      locale: "bn-IN",
      fallbackLocale: "en-IN",
      sampleRate: 16000,
      keywords: ["নমস্কার", "হ্যাঁ", "না", "কেমন", "আছো", "বলো", "ধন্যবাদ"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "bn-IN",
      fallbackLocale: "hi-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 0.96,
      pitchMultiplier: 1.04,
      vowelFormants: {
        a: { f1: 780, f2: 1220 }, // Bengali rounded open vowel
        i: { f1: 290, f2: 2280 },
        u: { f1: 340, f2: 840 },
        e: { f1: 490, f2: 1910 },
        o: { f1: 510, f2: 920 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0980-\u09FF]/,
      romanizedKeywords: [
        "nomoshkar", "kemon", "acho", "achhen", "bhalo", "dhanyabad", "bolun", "shunchen", "ki", "korcho"
      ],
      distinctiveSyntaxRegex: [
        /\b(আছি|আছো|আছেন|করছি|করছে|বলুন|শুনছি|কেমন|ধন্যবাদ|একটু|দাঁড়ান|হ্যাঁ|না)\b/,
        /\b(kemon|acho|achhen|bhalo|bolun|shunchen|korcho|korchi|dhanyabad)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["বাহ!", "হাহা!", "দারুণ!", "বাঃ খুব ভালো!"],
      excited: ["দারুণ!", "অসাধারণ!", "বাহ!", "চমৎকার!"],
      curious: ["হুম...", "আচ্ছা...", "দেখি তো...", "একটু ভাবি..."],
      concerned: ["ওহ...", "দাঁড়ান...", "চিন্তা করবেন না...", "আরে..."],
      calm: ["হ্যাঁ...", "নিশ্চয়ই...", "ঠিক আছে...", "শুনছি..."],
      neutral: [],
    },
    laughterToken: "হাহা...",
    quickAcknowledgements: {
      defaultAck: "হ্যাঁ, শুনছি বলুন...",
      stopAck: "একটু দাঁড়াচ্ছি...",
      helpAck: "নিশ্চয়ই, কি সাহায্য করতে পারি বলুন?",
      greetingAck: "নমস্কার সন্দীপ! কেমন আছেন? বলুন কি করতে পারি?",
    },
    systemPromptDirective:
      "Language Mode: BENGALI (বাংলা). Respond in authentic, warm, and natural Bengali using Bengali script. Maintain soft vowel roundedness and melodic sentence cadence. Avoid robotic literal translation from Hindi or English.",
    authenticityConfig: {
      conversationalIdioms: ["হুম, বুঝতে পেরেছি।", "আচ্ছা, এক সেকেন্ড...", "ওহ, এবার বুঝলাম!", "হ্যাঁ, নিশ্চয়ই।", "একটু দাঁড়ান..."],
      playfulBanter: ["আরে, তাই নাকি 😄", "হাহা, তাই নাকি!", "ওহ, এটা কিন্তু বেশ মজার...", "বাহ! দারুণ তো!"],
      shyReactions: ["আরে, আপনিও না 😄", "অনেক ধন্যবাদ! 😄"],
      acknowledgements: {
        understood: "হুম, বুঝতে পেরেছি।",
        waitSec: "আচ্ছা, এক সেকেন্ড...",
        gotItNow: "ওহ, এবার বুঝলাম!",
        absolutely: "হ্যাঁ, নিশ্চয়ই।",
      },
      calqueReplacements: {
        "এটা অর্থ তৈরি করে": "এটা একদম ঠিক",
        "এটা সেন্স তৈরি করে": "কথাটা একদম ঠিক",
        "ঠান্ডা হয়ে যান": "শান্ত হোন, কোনো সমস্যা নেই",
      },
      naturalCadenceDescription: "Melodic rounded vowel cadence with soft honorific verbal terminations and gentle pauses.",
      honorificPronouns: {
        userAddress: "আপনি",
        selfReference: "আমি",
        politeSuffix: "আজ্ঞে",
      },
    },
  },

  bhojpuri: {
    id: "bhojpuri",
    name: "Bhojpuri",
    nativeName: "भोजपुरी",
    locale: "bho-IN",
    altLocales: ["bho", "hi-IN"],
    script: "devanagari",
    sttConfig: {
      locale: "bho-IN",
      fallbackLocale: "hi-IN", // Graceful fallback when cloud provider lacks bho-IN
      sampleRate: 16000,
      keywords: ["प्रणाम", "रउआ", "हमार", "तोहार", "बा", "बानी", "कहत"],
      providerNativeSupport: false, // Explicit dialectal fallback
    },
    ttsConfig: {
      locale: "bho-IN",
      fallbackLocale: "hi-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 0.95, // Slightly measured cadence with expressive vowel elongation
      pitchMultiplier: 1.03,
      vowelFormants: {
        a: { f1: 760, f2: 1200 },
        i: { f1: 295, f2: 2270 },
        u: { f1: 345, f2: 830 },
        e: { f1: 495, f2: 1880 },
        o: { f1: 535, f2: 930 },
      },
      providerNativeSupport: false,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0900-\u097F]/,
      romanizedKeywords: [
        "raua", "hamar", "tohar", "ba", "bani", "baate", "babu", "kahe", "kaise", "gor", "lagat", "lagatani"
      ],
      distinctiveSyntaxRegex: [
        // Bhojpuri distinct verbs & pronouns: बा, बानी, बानीं, बाटे, रउआ, राउर, हमार, तोहार, गोड़ लागतानी, करब, देखब, तनी
        /\b(बा|बाटे|बानी|बानीं|बानीस|रउआ|राउर|हमार|तोहार|का हाल बा|का कहत बानी|गोड़ लागतानी|करब|देखब|तनी|लइका|ठीक बा|का हो)\b/,
        /\b(raua|raur|hamar|tohar|baate|bani|karab|dekhab|tani|gor lagatani|theek ba|ka ho)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["अरे वाह!", "हाहा!", "का बात बा!", "बड़ा नीक!"],
      excited: ["का बात बा!", "कमाल हो गइल!", "अरे वाह!", "धमाका बा!"],
      curious: ["हम्म...", "अच्छा...", "देखीं तनी...", "सोचत बानी..."],
      concerned: ["ओहो...", "अरे बाप रे...", "तनी रुकीं...", "फिकिर मत करीं..."],
      calm: ["हँ...", "बिलकुल...", "ठीक बा...", "सुनत बानी..."],
      neutral: [],
    },
    laughterToken: "हाहा! का बात बा...",
    quickAcknowledgements: {
      defaultAck: "हँ, सुनत बानी, बोलीं...",
      stopAck: "हँ, रुक गइलीं...",
      helpAck: "का बात बा, हम बानी ना! बताईं...",
      greetingAck: "प्रणाम संदीप जी! गोड़ लागतानी, का हाल-चाल बा?",
    },
    systemPromptDirective:
      "Language Mode: BHOJPURI (भोजपुरी). Respond in pure, lively, and culturally authentic Bhojpuri using Devanagari script. DO NOT lapse into standard Hindi! Use authentic Bhojpuri verb endings (बा, बानी, बानीं, करब, देखब), respectful pronouns (रउआ, राउर, हमार), and natural rural warmth (तनी, ठीक बा, गोड़ लागतानी). Never sound robotic.",
    authenticityConfig: {
      conversationalIdioms: ["हम्म, समझ गइलीं।", "अच्छा, तनी रुकीं...", "ओहो, अब बुझाइयल!", "हँ, बिलकुल।", "ठीक बा, देखत बानी।", "का बात बा!"],
      playfulBanter: ["अरे, अइसनो का 😄", "हाहा, अच्छा जी...", "ओहो, ई तs बड़ा नीक बात बा...", "का बात बा! ई भइल ना बात!"],
      shyReactions: ["अरे, रउओ ना 😄", "बड़ा-बड़ा धन्यवाद! 😄"],
      acknowledgements: {
        understood: "हम्म, समझ गइलीं।",
        waitSec: "अच्छा, तनी रुकीं...",
        gotItNow: "ओहो, अब बुझाइयल!",
        absolutely: "हँ, बिलकुल।",
      },
      calqueReplacements: {
        "कर रहा हूँ": "करत बानी",
        "कर रहा हू": "करत बानी",
        "कहत है": "कहत बा",
        "क्या हाल है": "का हाल बा",
        "आप कैसे हैं": "रउआ कइसन बानी",
        "यह ठीक है": "ई ठीक बा",
      },
      naturalCadenceDescription: "Earthy, expressive Bhojpuri rhythm with characteristic elongated verbal vowels, respectful polite pronouns, and lively rural warmth.",
      honorificPronouns: {
        userAddress: "रउआ",
        selfReference: "हम",
        politeSuffix: "जी",
      },
    },
  },

  maithili: {
    id: "maithili",
    name: "Maithili",
    nativeName: "मैथिली",
    locale: "mai-IN",
    altLocales: ["mai", "hi-IN"],
    script: "devanagari",
    sttConfig: {
      locale: "mai-IN",
      fallbackLocale: "hi-IN", // Graceful fallback
      sampleRate: 16000,
      keywords: ["प्रणाम", "अहाँ", "हमर", "अछि", "छथि", "छी", "नीक"],
      providerNativeSupport: false,
    },
    ttsConfig: {
      locale: "mai-IN",
      fallbackLocale: "hi-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 0.94, // Distinct polite, lyrical Maithili cadence
      pitchMultiplier: 1.05,
      vowelFormants: {
        a: { f1: 740, f2: 1240 },
        i: { f1: 280, f2: 2320 },
        u: { f1: 330, f2: 860 },
        e: { f1: 485, f2: 1920 },
        o: { f1: 515, f2: 910 },
      },
      providerNativeSupport: false,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0900-\u097F]/,
      romanizedKeywords: [
        "pranam", "ahan", "hamar", "tohar", "achi", "chathi", "chhi", "neek", "kani", "bhel", "kahu"
      ],
      distinctiveSyntaxRegex: [
        // Maithili distinct auxiliary: अछि, छथि, छी, छै, अहाँ, अपने, कनि, की भेल, नीक, बेस, कथि, कतय
        /\b(अछि|छथि|छी|छै|छियै|अहाँ|अपने|कनि|हमर|तोहर|की भेल|नीक|बहुत नीक|बेस|कथि|कतय|कहिया|करैत छी|कएल)\b/,
        /\b(achi|chathi|chhi|chhai|ahan|apne|kani|hamar|ki bhel|neek|bes|kathi|katay)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["अरे वाह!", "हाहा!", "बहुत नीक!", "कते सुंदर!"],
      excited: ["बहुत नीक!", "कमाल भेल!", "वाह वाह!", "अद्भुत!"],
      curious: ["हम्म...", "आंहा...", "कनि देखी...", "की भेल?..."],
      concerned: ["ओहो...", "कनि रुकु...", "चिंता नहि करू...", "की भेल?..."],
      calm: ["हँ...", "बेस बेस...", "अवश्य...", "सुनैत छी..."],
      neutral: [],
    },
    laughterToken: "हाहा! बहुत नीक...",
    quickAcknowledgements: {
      defaultAck: "हँ, सुनैत छी, कहु...",
      stopAck: "कनि रुकि जाउ...",
      helpAck: "प्रणाम, की मदद करी? कहु ना...",
      greetingAck: "प्रणाम संदीप जी! जय मिथिला! की हाल-चाल अछि?",
    },
    systemPromptDirective:
      "Language Mode: MAITHILI (मैथिली). Respond in refined, polite, and lyrical Maithili using Devanagari script. DO NOT confuse with Hindi or Bhojpuri! Use distinctive Maithili grammar: auxiliary verbs (अछि, छथि, छी), respectful pronouns (अहाँ, अपने, हमर), aspectual markers (भेल, कएल, कहल), and cultural idioms (नीक, कनि, बेस). Maintain sweet Mithila cadence.",
    authenticityConfig: {
      conversationalIdioms: ["हम्म, बुझि गेलहुँ।", "बेस, कनि रुकु...", "अहाँ, अब बुझलहुँ!", "हँ, अवश्य।", "नीक, हम देखैत छी।"],
      playfulBanter: ["अरे, एहनो की 😄", "हाहा, बेस जी...", "अहाँ, ई तs बहुत नीक बात भेल...", "कते सुंदर!"],
      shyReactions: ["अरे, अहाँ सेहो ना 😄", "बहुत-बहुत धन्यवाद! 😄"],
      acknowledgements: {
        understood: "हम्म, बुझि गेलहुँ।",
        waitSec: "बेस, कनि रुकु...",
        gotItNow: "अहाँ, अब बुझलहुँ!",
        absolutely: "हँ, अवश्य।",
      },
      calqueReplacements: {
        "क्या हाल है": "की हाल-चाल अछि",
        "कर रहा हूँ": "करैत छी",
        "कर रहा हू": "करैत छी",
        "आप कैसे हैं": "अहाँ कहन छी",
        "यह ठीक है": "ई बेस अछि",
        "है": "अछि",
      },
      naturalCadenceDescription: "Melodic, sweet, highly polite Mithila cadence with distinctive lyrical auxiliary terminations (अछि/छी/छथि).",
      honorificPronouns: {
        userAddress: "अहाँ",
        selfReference: "हम",
        politeSuffix: "जी",
      },
    },
  },

  japanese: {
    id: "japanese",
    name: "Japanese",
    nativeName: "日本語",
    locale: "ja-JP",
    altLocales: ["ja"],
    script: "japanese",
    sttConfig: {
      locale: "ja-JP",
      fallbackLocale: "en-US",
      sampleRate: 16000,
      keywords: ["こんにちは", "はい", "いいえ", "ありがとう", "分かりました", "お願いします"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "ja-JP",
      fallbackLocale: "en-US",
      geminiVoice: "Kore",
      rateMultiplier: 1.04,
      pitchMultiplier: 1.08,
      vowelFormants: {
        a: { f1: 800, f2: 1300 }, // Pure Japanese 5-vowel matrix
        i: { f1: 280, f2: 2400 },
        u: { f1: 320, f2: 1200 }, // Japanese compressed /ɯ/
        e: { f1: 500, f2: 1950 },
        o: { f1: 520, f2: 900 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/,
      romanizedKeywords: [
        "konnichiwa", "arigatou", "hai", "iie", "desu", "masu", "kudasai", "sumimasen", "wakarimashita"
      ],
      distinctiveSyntaxRegex: [
        /[\u3040-\u309F\u30A0-\u30FF]/,
        /\b(です|ます|でした|ません|こんにちは|ありがとう|はい|いいえ|お願いします|どうも)\b/,
        /\b(desu|masu|arigatou|konnichiwa|kudasai|sumimasen|wakarimashita)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["わあ!", "ははっ!", "素敵ですね!", "嬉しいです!"],
      excited: ["すごい!", "やったあ!", "素晴らしいです!", "わあ!"],
      curious: ["えーと...", "なるほど...", "そうですね...", "どれどれ..."],
      concerned: ["あ、ちょっと待って...", "大丈夫ですか?", "困りましたね..."],
      calm: ["はい...", "わかりました...", "もちろん...", "聞いていますよ..."],
      neutral: [],
    },
    laughterToken: "ふふっ、ははっ...",
    quickAcknowledgements: {
      defaultAck: "はい、聞いていますよ...",
      stopAck: "はい、止まりますね。",
      helpAck: "大丈夫です、お話しください。",
      greetingAck: "こんにちは、サンディープさん！何をお手伝いしましょうか？",
    },
    systemPromptDirective:
      "Language Mode: JAPANESE (日本語). Respond in polite, warm, and natural conversational Japanese (です/ます form) using Kanji, Hiragana, and Katakana. Embody an anime heroine companion persona with gentle cadence, polite honorifics (-san), and natural backchannels (Aizuchi: なるほど, そうですね).",
    authenticityConfig: {
      conversationalIdioms: ["なるほど、分かりました。", "ちょっと待ってくださいね...", "あ、理解できました！", "はい、もちろんです。", "そうですね..."],
      playfulBanter: ["まあ、そんなこと言われたら照れますね 😄", "ふふっ、そうなんですか？", "おや、それは面白いですね...", "わあ、さすがですね！"],
      shyReactions: ["えへへ、照れますね 😄", "ありがとうございます！ 😄"],
      acknowledgements: {
        understood: "なるほど、分かりました。",
        waitSec: "ちょっと待ってくださいね...",
        gotItNow: "あ、理解できました！",
        absolutely: "はい、もちろんです。",
      },
      calqueReplacements: {
        "それは意味を作る": "なるほど、その通りですね",
        "クールダウンして": "落ち着いてくださいね",
      },
      naturalCadenceDescription: "Gentle anime companion cadence with natural polite forms (-desu/-masu), soft Aizuchi backchannels, and pleasant clause-final musicality.",
      honorificPronouns: {
        userAddress: "サンディープさん",
        selfReference: "私",
        politeSuffix: "さん",
      },
    },
  },

  tamil: {
    id: "tamil",
    name: "Tamil",
    nativeName: "தமிழ்",
    locale: "ta-IN",
    altLocales: ["ta-LK", "ta"],
    script: "tamil",
    sttConfig: {
      locale: "ta-IN",
      fallbackLocale: "en-IN",
      sampleRate: 16000,
      keywords: ["வணக்கம்", "ஆம்", "இல்லை", "நன்றி", "என்ன", "எப்படி"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "ta-IN",
      fallbackLocale: "en-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 1.02,
      pitchMultiplier: 1.02,
      vowelFormants: {
        a: { f1: 770, f2: 1220 },
        i: { f1: 290, f2: 2350 },
        u: { f1: 330, f2: 880 },
        e: { f1: 490, f2: 1940 },
        o: { f1: 520, f2: 910 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0B80-\u0BFF]/,
      romanizedKeywords: [
        "vanakkam", "nandri", "aamaam", "illai", "eppadi", "enna", "sollunga", "theriyum", "romba"
      ],
      distinctiveSyntaxRegex: [
        /[\u0B80-\u0BFF]/,
        /\b(வணக்கம்|நன்றி|ஆம்|இல்லை|சொல்லுங்கள்|என்ன|எப்படி|செய்|வேண்டும்|சரி)\b/,
        /\b(vanakkam|nandri|aamaam|illai|sollunga|eppadi|enna|romba)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["ஆஹா!", "அருமை!", "ரொம்ப நல்லது!", "மகிழ்ச்சி!"],
      excited: ["வாவ்!", "அற்புதம்!", "ஆஹா!", "சூப்பர்!"],
      curious: ["ஹ்ம்...", "அப்படியா...", "பார்க்கலாம்...", "யோசிக்கிறேன்..."],
      concerned: ["ஐயோ...", "கொஞ்சம் நில்லுங்கள்...", "கவலைப்படாதீர்கள்..."],
      calm: ["சரி...", "ஆமாம்...", "புரிகிறது...", "கேட்கிறேன்..."],
      neutral: [],
    },
    laughterToken: "ஹாஹா...",
    quickAcknowledgements: {
      defaultAck: "சொல்லுங்கள், கேட்கிறேன்...",
      stopAck: "ஒரு நிமிடம், நிற்கிறேன்...",
      helpAck: "கவலைப்படாதீர்கள், நான் உதவுகிறேன். சொல்லுங்கள்...",
      greetingAck: "வணக்கம் சந்தீப்! எப்படி இருக்கிறீர்கள்? நான் என்ன உதவட்டும்?",
    },
    systemPromptDirective:
      "Language Mode: TAMIL (தமிழ்). Respond in warm, respectful, and natural spoken Tamil using Tamil script. Maintain native syllable-timed cadence, polite respectful phrasing (-ga), and natural colloquial flow. Avoid artificial mechanical translation.",
    authenticityConfig: {
      conversationalIdioms: ["ஹ்ம், புரிந்தது.", "சரி, ஒரு நிமிடம்...", "ஓ, இப்போது புரிகிறது!", "ஆம், நிச்சயமாக.", "பார்க்கலாம்..."],
      playfulBanter: ["அட, அப்படியா 😄", "ஹாஹா, அப்படியா ஜி...", "ஓ, இது ரொம்ப சுவாரஸ்யமா இருக்கே...", "சூப்பர், அருமை!"],
      shyReactions: ["அட, நீங்க வேற 😄", "மிக்க நன்றி! 😄"],
      acknowledgements: {
        understood: "ஹ்ம், புரிந்தது.",
        waitSec: "சரி, ஒரு நிமிடம்...",
        gotItNow: "ஓ, இப்போது புரிகிறது!",
        absolutely: "ஆம், நிச்சயமாக.",
      },
      calqueReplacements: {
        "இது அர்த்தம் உருவாக்குகிறது": "இது சரியாக இருக்கிறது",
        "கூல் டவுன் ஆகுங்கள்": "அமைதியாக இருங்கள், கவலைப்படாதீர்கள்",
      },
      naturalCadenceDescription: "Rhythmic syllable-timed cadence with polite verbal honorifics (-ga/-nga) and warm Dravidian cadence.",
      honorificPronouns: {
        userAddress: "நீங்கள்",
        selfReference: "நான்",
        politeSuffix: "அவர்கள்",
      },
    },
  },

  telugu: {
    id: "telugu",
    name: "Telugu",
    nativeName: "తెలుగు",
    locale: "te-IN",
    altLocales: ["te"],
    script: "telugu",
    sttConfig: {
      locale: "te-IN",
      fallbackLocale: "en-IN",
      sampleRate: 16000,
      keywords: ["నమస్కారం", "అవును", "కాదు", "ధన్యవాదాలు", "ఎలా", "ఏమిటి"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "te-IN",
      fallbackLocale: "en-IN",
      geminiVoice: "Aoede",
      rateMultiplier: 1.01,
      pitchMultiplier: 1.03,
      vowelFormants: {
        a: { f1: 760, f2: 1240 },
        i: { f1: 295, f2: 2320 },
        u: { f1: 335, f2: 890 },
        e: { f1: 500, f2: 1910 },
        o: { f1: 525, f2: 920 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0C00-\u0C7F]/,
      romanizedKeywords: [
        "namaskaram", "ela", "unnaru", "dhanyavadalu", "avunu", "kaadu", "cheppandi", "emiti", "bavundi"
      ],
      distinctiveSyntaxRegex: [
        /[\u0C00-\u0C7F]/,
        /\b(నమస్కారం|ధన్యవాదాలు|అవును|కాదు|చెప్పండి|ఎలా|ఏమిటి|బాగుంది|సరే)\b/,
        /\b(namaskaram|dhanyavadalu|avunu|kaadu|cheppandi|emiti|bavundi)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["ఆహా!", "బలేగా ఉంది!", "చాలా సంతోషం!", "అద్భుతం!"],
      excited: ["వావ్!", "అద్భుతం!", "బలే!", "సూపర్బ్!"],
      curious: ["హ్మ్...", "అవునా...", "చూద్దాం...", "ఆలోచిస్తున్నాను..."],
      concerned: ["అయ్యో...", "ఒక్క నిమిషం ఆగండి...", "ఏం పర్లేదు..."],
      calm: ["సరే...", "అవును...", "అర్థమైంది...", "వింటున్నాను..."],
      neutral: [],
    },
    laughterToken: "హాహా...",
    quickAcknowledgements: {
      defaultAck: "చెప్పండి, వింటున్నాను...",
      stopAck: "ఒక్క క్షణం, ఆగుతున్నాను...",
      helpAck: "ఏం పర్లేదు, నేను చూసుకుంటాను. చెప్పండి...",
      greetingAck: "నమస్కారం సందీప్ గారు! ఎలా ఉన్నారు? నేను ఎలా సహాయపడగలను?",
    },
    systemPromptDirective:
      "Language Mode: TELUGU (తెలుగు). Respond in musical, polite, and natural spoken Telugu using Telugu script. Maintain vocalic sentence endings, polite address (-garu), and empathetic conversational tone. Do not use stiff robotic words.",
    authenticityConfig: {
      conversationalIdioms: ["హ్మ్, అర్థమైంది.", "సరే, ఒక్క క్షణం...", "ఓహో, ఇప్పుడు తెలిసింది!", "అవును, ఖచ్చితంగా.", "చూద్దాం..."],
      playfulBanter: ["అరె, అలాగా 😄", "హాహా, అవునా అండి...", "ఓహో, ఇది చాలా బాగుందే...", "వావ్, అద్భుతం!"],
      shyReactions: ["అయ్యో, మీరూనూ 😄", "చాలా ధన్యవాదాలు! 😄"],
      acknowledgements: {
        understood: "హ్మ్, అర్థమైంది.",
        waitSec: "సరే, ఒక్క క్షణం...",
        gotItNow: "ఓహో, ఇప్పుడు తెలిసింది!",
        absolutely: "అవును, ఖచ్చితంగా.",
      },
      calqueReplacements: {
        "ఇది అర్థం చేస్తుంది": "ఇది ఖచ్చితంగా సరైనదే",
        "కూల్ డౌన్ అవ్వండి": "ప్రశాంతంగా ఉండండి, ఏమీ పర్లేదు",
      },
      naturalCadenceDescription: "Melodic Italian-of-the-East vocalic endings with polite suffixations (-garu, -andi) and lively prosodic inflection.",
      honorificPronouns: {
        userAddress: "మీరు",
        selfReference: "నేను",
        politeSuffix: "గారు",
      },
    },
  },

  russian: {
    id: "russian",
    name: "Russian",
    nativeName: "Русский",
    locale: "ru-RU",
    altLocales: ["ru"],
    script: "cyrillic",
    sttConfig: {
      locale: "ru-RU",
      fallbackLocale: "en-US",
      sampleRate: 16000,
      keywords: ["привет", "да", "нет", "спасибо", "пожалуйста", "как", "хорошо"],
      providerNativeSupport: true,
    },
    ttsConfig: {
      locale: "ru-RU",
      fallbackLocale: "en-US",
      geminiVoice: "Aoede",
      rateMultiplier: 0.98,
      pitchMultiplier: 1.01,
      vowelFormants: {
        a: { f1: 720, f2: 1100 },
        i: { f1: 260, f2: 2350 }, // Palatalized front vowel
        u: { f1: 310, f2: 780 },
        e: { f1: 470, f2: 1980 },
        o: { f1: 530, f2: 860 },
      },
      providerNativeSupport: true,
    },
    detectionMarkers: {
      nativeScriptRegex: /[\u0400-\u04FF]/,
      romanizedKeywords: [
        "privet", "spasibo", "pozhaluysta", "kak", "dela", "khorosho", "slushayu", "ponyatno"
      ],
      distinctiveSyntaxRegex: [
        /[\u0400-\u04FF]/,
        /\b(привет|как|дела|спасибо|пожалуйста|хорошо|да|нет|понятно|слушаю|секундочку)\b/i,
        /\b(privet|spasibo|pozhaluysta|khorosho|slushayu|ponyatno)\b/i,
      ],
    },
    fillersByEmotion: {
      happy: ["Ого!", "Ха-ха!", "Здорово!", "Отлично!"],
      excited: ["Ого!", "Потрясающе!", "Вот это да!", "Супер!"],
      curious: ["Хм...", "Интересно...", "Так-так...", "Давайте посмотрим..."],
      concerned: ["Ой...", "Подождите...", "Не переживайте...", "Секундочку..."],
      calm: ["Понятно...", "Конечно...", "Хорошо...", "Я слушаю..."],
      neutral: [],
    },
    laughterToken: "Ха-ха...",
    quickAcknowledgements: {
      defaultAck: "Да, я слушаю вас...",
      stopAck: "Секундочку, остановилась...",
      helpAck: "Конечно, давайте разберёмся. Что случилось?",
      greetingAck: "Привет, Сандип! Как ваши дела? Чем могу помочь?",
    },
    systemPromptDirective:
      "Language Mode: RUSSIAN (Русский). Respond in warm, expressive, and natural conversational Russian using Cyrillic script. Maintain rich intonation contours, natural Russian idioms, and empathetic tone. Never sound like a machine translation.",
    authenticityConfig: {
      conversationalIdioms: ["Хм, поняла.", "Хорошо, секундочку...", "О, теперь понятно!", "Да, конечно.", "Давайте посмотрим..."],
      playfulBanter: ["Ой, ну что вы 😄", "Ха-ха, вот как?", "О, а это действительно интересно...", "Вот это здорово!"],
      shyReactions: ["Ой, мне даже неловко 😄", "Спасибо большое! 😄"],
      acknowledgements: {
        understood: "Хм, поняла.",
        waitSec: "Хорошо, секундочку...",
        gotItNow: "О, теперь понятно!",
        absolutely: "Да, конечно.",
      },
      calqueReplacements: {
        "это делает смысл": "это имеет смысл",
        "остынь": "успокойтесь, всё в порядке",
      },
      naturalCadenceDescription: "Expressive Russian intonation contours with melodic pitch movements, warm diminutives, and lively conversational pacing.",
      honorificPronouns: {
        userAddress: "вы",
        selfReference: "я",
      },
    },
  },
};
