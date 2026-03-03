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
// ROOT (Prevents Railway health issues)
// =============================
app.get("/", (req, res) => {
  res.send("LeadHook Voice AI Running");
});

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
      to: "+919606746900",
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
      // If no speech, ask again
      return generateAndPlay(
        "Sorry, I didn't catch that. Could you repeat?",
        res,
        true,
        callSid
      );
    }

    console.log("User said:", transcript);

    const session = sessions[callSid];

    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a real estate AI.

Update:
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
${transcript}
`
        }
      ]
    });

    const result = JSON.parse(ai.choices[0].message.content);

    sessions[callSid] = result.updated_session;

    console.log("Updated Session:", sessions[callSid]);

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
    console.error("PROCESS ERROR:", err.message);
    res.status(500).send("Error");
  }
});

// =============================
// DYNAMIC AUDIO ROUTE
// =============================
app.get("/dynamic-audio", (req, res) => {
  const callSid = req.query.callSid;
  const audio = audioStore[callSid];

  if (!audio) return res.status(404).send("No audio");

  res.set("Content-Type", "audio/mpeg");
  res.send(audio);
});

// =============================
// TTS + TWIML
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

    // ✅ PLAY FULL AUDIO FIRST
    twiml.play(`${BASE_URL}/dynamic-audio?callSid=${callSid}`);

    if (continueGather) {
      // ✅ THEN LISTEN
      twiml.gather({
        input: "speech",
        action: "/process-speech",
        method: "POST",
        timeout: 2,
        speechTimeout: "auto"
      });
    } else {
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