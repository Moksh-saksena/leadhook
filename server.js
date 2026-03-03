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

// Root
app.get("/", (req, res) => {
  res.send("LeadHook Voice AI Running");
});

// Outbound trigger
app.get("/call", async (req, res) => {
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
});

// Entry
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

  await generateAudio(greeting, callSid);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(`${BASE_URL}/dynamic-audio?callSid=${callSid}`);
  twiml.redirect("/listen"); // 🔥 critical

  res.type("text/xml").send(twiml.toString());
});

// Listening endpoint
app.post("/listen", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.gather({
    input: "speech",
    action: "/process-speech",
    method: "POST",
    timeout: 3,
    speechTimeout: "auto"
  });

  res.type("text/xml").send(twiml.toString());
});

// Process speech
app.post("/process-speech", async (req, res) => {
  const callSid = req.body.CallSid;
  const transcript = req.body.SpeechResult;

  if (!transcript) {
    return res.redirect("/listen");
  }

  console.log("User said:", transcript);

  const session = sessions[callSid];

  const ai = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Update session fields.
Ask next short question.
Return JSON:
{
 "updated_session": {...},
 "next_message": "...",
 "should_end": true/false
}`
      },
      {
        role: "user",
        content: `
Session: ${JSON.stringify(session)}
User said: ${transcript}
`
      }
    ]
  });

  const result = JSON.parse(ai.choices[0].message.content);

  sessions[callSid] = result.updated_session;

  await generateAudio(result.next_message, callSid);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(`${BASE_URL}/dynamic-audio?callSid=${callSid}`);

  if (!result.should_end) {
    twiml.redirect("/listen");
  } else {
    twiml.hangup();
    delete sessions[callSid];
  }

  res.type("text/xml").send(twiml.toString());
});

// Audio route
app.get("/dynamic-audio", (req, res) => {
  const callSid = req.query.callSid;
  const audio = audioStore[callSid];

  if (!audio) return res.status(404).send("No audio");

  res.set("Content-Type", "audio/mpeg");
  res.send(audio);
});

// TTS generator
async function generateAudio(text, callSid) {
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
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});