export interface ConversationResponse {
  speech: string;
  drawingSequence?: string;
  portalWorld?: string;
  followUp?: string;
}

interface Rule {
  patterns: RegExp[];
  response: ConversationResponse;
}

const RULES: Rule[] = [
  {
    patterns: [/fraction/i, /half/i, /\bone\s+over\b/i, /divide/i],
    response: {
      speech: "Fractions! Let me show you what one half and one third look like.",
      drawingSequence: "fractions",
      followUp:
        "See? One half means one piece out of two equal pieces. The blue bar shows how much that is. Try drawing your own!",
    },
  },
  {
    patterns: [/solar system/i, /planet/i, /jupiter/i, /space/i, /star/i],
    response: {
      speech:
        "The solar system! Let me sketch it for you. Double-click the circle to go inside and explore Jupiter up close.",
      drawingSequence: "solar-system",
      portalWorld: "solar-system",
    },
  },
  {
    patterns: [/cell/i, /biology/i, /mitochondria/i, /nucleus/i],
    response: {
      speech:
        "A cell, the building block of all living things! Let me draw one. Double-click it to go inside.",
      drawingSequence: "cell",
      portalWorld: "cell",
    },
  },
  {
    patterns: [/hello/i, /^hi\b/i, /^hey\b/i, /what can you do/i],
    response: {
      speech:
        "Hi there! I'm your learning companion. Tell me what you'd like to explore. Try saying fractions, solar system, or cell!",
    },
  },
  {
    patterns: [/help/i, /how does this work/i, /what do i do/i],
    response: {
      speech:
        "You can draw anything on this canvas, and I'll draw too! Say a topic like fractions or solar system, and I'll explain it with drawings.",
    },
  },
  {
    patterns: [/clear/i, /erase/i, /start over/i, /reset/i],
    response: {
      speech: "Let me clear the canvas so we can start fresh.",
      drawingSequence: "__clear__",
    },
  },
];

const FALLBACK: ConversationResponse = {
  speech:
    "Interesting! Try asking me about fractions, the solar system, or cells. I'll draw and explain!",
};

export function matchConversation(transcript: string): ConversationResponse {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(transcript))) {
      return rule.response;
    }
  }
  return FALLBACK;
}
