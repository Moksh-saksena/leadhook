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

// =============================
// VOICE ENTRY
// =============================
app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;

  // DO NOT RESET if already exists
  if (!sessions[callSid]) {
    sessions[callSid] = {
      is_interested: null,
      budget_range: null,
      timeline: null,
      location_preference: null,
    };
  }

  const greeting =
    "Hi, this is from the property team. Just checking, are you still looking for a property?";

  await generateAndPlay(greeting, res, true);
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
You are a real estate AI qualification engine.

Given:
1) Current session state
2) New user response

Update:
- is_interested
- budget_range
- timeline
- location_preference

Then decide the next natural question.
If qualification complete OR not interested → should_end=true.

Return ONLY JSON:

{
  "updated_session": {
    "is_interested": true/false/null,
    "budget_range": string|null,
    "timeline": string|null,
    "location_preference": string|null
  },
  "next_message": "short natural response under 15 words",
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
      !result.should_end
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
// TTS + RESPONSE
// =============================
async function generateAndPlay(text, res, continueGather) {
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
        speech_sample_rate: 22050,
        output_audio_codec: "mp3",
        enable_preprocessing: true
      },
      responseType: "arraybuffer"
    });

    const audioBuffer = response.data;

    // Serve dynamic audio
    app.get("/dynamic-audio", (req2, res2) => {
      res2.set("Content-Type", "audio/mpeg");
      res2.send(audioBuffer);
    });

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.play(`${BASE_URL}/dynamic-audio`);

    if (continueGather) {
      twiml.gather({
        input: "speech",
        action: "/process-speech",
        method: "POST",
        speechTimeout: "auto",
        timeout: 4
      });
    }

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error("TTS ERROR:", err.message);
    res.status(500).send("Error");
  }
}
app.get("/call", async (req, res) => {
  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    await client.calls.create({
      to: "+919606746900",  // your test number
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice`
    });

    res.send("Calling lead...");
  } catch (err) {
    console.error("CALL ERROR:", err.message);
    res.status(500).send("Failed to call");
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});