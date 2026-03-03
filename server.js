require("dotenv").config();
const express = require("express");
const { OpenAI } = require("openai");
const twilio = require("twilio");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BASE_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

const sessions = {};
const audioStore = {};

// =============================
// OUTBOUND CALL TRIGGER
// =============================
app.get("/call", async (req, res) => {
  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    await client.calls.create({
      to: "+919606746900", // change if needed
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice`
    });

    res.send("Calling lead...");
  } catch (err) {
    console.error("CALL ERROR:", err.message);
    res.status(500).send("Failed to call");
  }
});

// =============================
// VOICE ENTRY
// =============================
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;

  if (!sessions[callSid]) {
    sessions[callSid] = {
      is_interested: null,
      budget_range: null,
      timeline: null,
      location_preference: null,
    };
  }

  const greeting =
    "Hi, this is from the property team. Are you still looking for a property?";

  await generateAndPlay(greeting, res, true, callSid);
});

// =============================
// PROCESS SPEECH
// =============================
app.post("/process-speech", async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const transcript = req.body.SpeechResult;

    if (!transcript) {
      return res.send("No speech detected");
    }

    console.log("User said:", transcript);

    let cleanedTranscript = transcript
      .replace(/KS/gi, "crore")
      .replace(/k s/gi, "crore")
      .replace(/cr/gi, "crore")
      .replace(/lakhs?/gi, "lakh");

    const session = sessions[callSid];

    console.log("Session BEFORE:", session);

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a real estate AI.

Update session fields:
- is_interested
- budget_range
- timeline
- location_preference

Ask next short question if needed.
End if not interested or complete.

Return JSON:
{
  "updated_session": {...},
  "next_message": "...",
  "should_end": true/false
}
`
        },
        {
          role: "user",
          content: `
Current session:
${JSON.stringify(session)}

User said:
${cleanedTranscript}
`
        }
      ]
    });

    const result = JSON.parse(ai.choices[0].message.content);

    sessions[callSid] = result.updated_session;

    console.log("Session AFTER:", sessions[callSid]);
    console.log("Next Message:", result.next_message);
    console.log("Should End:", result.should_end);

    await generateAndPlay(
      result.next_message,
      res,
      !result.should_end,
      callSid
    );

    if (result.should_end) {
      console.log("Final Lead:", sessions[callSid]);
      delete sessions[callSid];
    }

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).send("Error");
  }
});

// =============================
// DYNAMIC AUDIO ROUTE (STABLE)
// =============================
app.get("/dynamic-audio", (req, res) => {
  const callSid = req.query.callSid;
  const audio = audioStore[callSid];

  if (!audio) return res.status(404).send("No audio");

  res.set("Content-Type", "audio/mpeg");
  res.send(audio);
});

// =============================
// TTS GENERATION
// =============================
async function generateAndPlay(text, res, continueGather, callSid) {
  try {
    const response = await axios({
      method: "post",
      url: "https://api.sarvam.ai/text-to-speech/stream",
      headers: {
        "api-subscription-key": process.env.SARVAM_API_KEY,
        "Content-Type": "application/json"
      },
      data: {
        text,
        target_language_code: "en-IN",
        speaker: "ritu",
        model: "bulbul:v3",
        pace: 1.0,
        speech_sample_rate: 16000,
        output_audio_codec: "mp3",
        enable_preprocessing: false
      },
      responseType: "arraybuffer"
    });

    audioStore[callSid] = response.data;

    const twiml = new twilio.twiml.VoiceResponse();

    if (continueGather) {
      const gather = twiml.gather({
        input: "speech",
        action: "/process-speech",
        method: "POST",
        speechTimeout: "auto",
        timeout: 1,
        bargeIn: true
      });

      gather.play(`${BASE_URL}/dynamic-audio?callSid=${callSid}`);
    } else {
      twiml.play(`${BASE_URL}/dynamic-audio?callSid=${callSid}`);
      twiml.hangup();
    }

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error("TTS ERROR:", err.message);
    res.status(500).send("Error");
  }
}
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});