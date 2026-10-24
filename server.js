const express = require('express');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { Groq } = require('groq-sdk');

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'sapc_reviewer_secret_jwt_key_2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '831508871993-j7egn200ai4uvbqabkuka6s66juaikes.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// --- SQLite Database Setup ---
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database (database.sqlite).');
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT,
      is_google INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Database Helper Promises
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    return err ? reject(err) : resolve(this);
  });
});

// --- Authentication Endpoints ---

// 1. Register Account
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const existingUser = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await dbRun('INSERT INTO users (username, password, is_google) VALUES (?, ?, 0)', [username, hashedPassword]);

    res.json({ message: 'User registered successfully! You can now log in.' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// 2. Local Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);

    if (!user || user.is_google || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = jwt.sign({ username: user.username, id: user.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: 'Login successful', token, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// 3. Google Sign-In
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Google credential token missing.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    const picture = payload.picture || '';

    let user = await dbGet('SELECT * FROM users WHERE username = ?', [email]);
    if (!user) {
      const result = await dbRun('INSERT INTO users (username, password, is_google) VALUES (?, NULL, 1)', [email]);
      user = { id: result.lastID, username: email };
    }

    const token = jwt.sign({ username: email, id: user.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: 'Google login successful', token, username: email, picture });
  } catch (err) {
    console.error('Google Auth Error:', err.message);
    res.status(401).json({ error: 'Failed to authenticate Google account.' });
  }
});

// --- Groq Flashcard API ---

function missingKeyError(keyName) {
  const error = new Error(`${keyName} is missing. Add it to .env and restart the server.`);
  error.statusCode = 503;
  return error;
}

function findCardsArray(data, depth = 0) {
  if (Array.isArray(data)) {
    return data.length > 0 && data.every(card =>
      card &&
      typeof card === 'object' &&
      typeof card.question === 'string' &&
      typeof card.answer === 'string'
    ) ? data : null;
  }
  if (!data || typeof data !== 'object' || depth >= 3) return null;

  const entries = Object.entries(data);
  const cardsEntry = entries.find(([key]) => ['cards', 'flashcards'].includes(key.toLowerCase()));
  if (cardsEntry && Array.isArray(cardsEntry[1])) {
    return findCardsArray(cardsEntry[1], depth + 1);
  }

  for (const [, value] of entries) {
    const cards = findCardsArray(value, depth + 1);
    if (cards) return cards;
  }
  return null;
}

function cleanQuestionText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/^(\s*(true\s*(or|\/)?\s*false|tama\s*(o|\/)?\s*mali|t\s*\/\s*f)\s*[:.-]?\s*)+/gi, '')
    .replace(/[\s(--]*\b(true\s*(or|\/)?\s*false|tama\s*(o|\/)?\s*mali|t\s*\/\s*f)\b[\s)]*$/gi, '')
    .replace(/[\s.:\-?]+$/, '?')
    .trim();
}

function parseFlashcards(responseText) {
  const data = JSON.parse(responseText.trim());
  const cards = findCardsArray(data);
  if (!cards) {
    const error = new Error('The AI response did not include a valid cards array.');
    error.code = 'MISSING_CARDS_ARRAY';
    throw error;
  }

  const normalizedCards = cards.map(card => {
    if (typeof card.question !== 'string' || typeof card.answer !== 'string') return card;

    const rawAnswer = card.answer.trim();
    const isTrueFalseVerdict = /^(true|false|tama|mali)\b/i.test(rawAnswer);
    let question = isTrueFalseVerdict ? cleanQuestionText(card.question) : card.question;
    let normalizedAnswer = rawAnswer;
    let extractedExplanation = card.explanation || '';

    if (isTrueFalseVerdict) {
      const match = rawAnswer.match(/^(true|false|tama|mali)[.:\s-]*(.*)/i);
      if (match) {
        const rawVerdict = match[1].toLowerCase();
        if (rawVerdict === 'tama') normalizedAnswer = 'Tama';
        else if (rawVerdict === 'mali') normalizedAnswer = 'Mali';
        else normalizedAnswer = rawVerdict.charAt(0).toUpperCase() + rawVerdict.slice(1);

        if (match[2] && !extractedExplanation) {
          extractedExplanation = match[2].trim();
        }
      }
    }

    const answerItems = rawAnswer.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\d+[.)]\s+/.test(line));

    if (answerItems.length >= 2) {
      const questionLines = question.split(/\r?\n/);
      const firstAnswerItem = questionLines.findIndex(line => line.trim() === answerItems[0]);
      if (firstAnswerItem >= 0) {
        const duplicatedItems = questionLines.slice(firstAnswerItem, firstAnswerItem + answerItems.length);
        if (answerItems.every((item, index) => duplicatedItems[index]?.trim() === item)) {
          const promptLines = questionLines.slice(0, firstAnswerItem);
          while (promptLines.length && /^(?:answer|functions|these are|they are|mga sagot)\s*:?\s*$/i.test(promptLines[promptLines.length - 1].trim())) {
            promptLines.pop();
          }
          question = promptLines.join('\n').trim() || question;
        }
      }
    }

    const questionHasChoices = question.split(/\r?\n/).some(line => /^\s*[A-D][.)]\s+/.test(line));
    const type = isTrueFalseVerdict
      ? 'true-false'
      : questionHasChoices
        ? 'multiple-choice'
        : answerItems.length >= 2
          ? 'enumeration'
          : 'identification';

    return { 
      ...card, 
      question, 
      answer: normalizedAnswer, 
      explanation: extractedExplanation, 
      type 
    };
  });

  return { cards: normalizedCards };
}

async function generateWithGroq(messages, subjectMode = 'general', temperature = 0.5) {
  let apiKey = process.env.GROQ_API_KEY;
  let model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

  if (subjectMode === 'math') {
    if (process.env.GROQ_API_KEY_MATH) apiKey = process.env.GROQ_API_KEY_MATH;
    if (process.env.GROQ_MODEL_MATH) model = process.env.GROQ_MODEL_MATH;
  } else if (subjectMode === 'filipino') {
    if (process.env.GROQ_API_KEY_FILIPINO) apiKey = process.env.GROQ_API_KEY_FILIPINO;
    if (process.env.GROQ_MODEL_FILIPINO) model = process.env.GROQ_MODEL_FILIPINO;
  }

  if (!apiKey) throw missingKeyError('GROQ_API_KEY');

  const groq = new Groq({ apiKey: apiKey.trim() });

  const requestCompletion = requestMessages => groq.chat.completions.create({
    messages: requestMessages,
    model,
    response_format: { type: 'json_object' },
    temperature
  });

  const getResponseText = completion => completion.choices?.[0]?.message?.content;

  const completion = await requestCompletion(messages);
  const responseText = getResponseText(completion);
  if (!responseText) throw new Error('Groq returned an empty response.');

  try {
    return parseFlashcards(responseText);
  } catch (error) {
    if (error.code !== 'MISSING_CARDS_ARRAY') throw error;

    const correctedCompletion = await requestCompletion([
      ...messages,
      { role: 'assistant', content: responseText },
      {
        role: 'user',
        content: 'Reformat your previous answer as a valid JSON object with a top-level "cards" array. Each array item must contain string "question" and "answer" fields. Preserve the same study content and return only that JSON object.'
      }
    ]);
    const correctedResponseText = getResponseText(correctedCompletion);
    if (!correctedResponseText) throw new Error('Groq returned an empty response while correcting the flashcard format.');
    return parseFlashcards(correctedResponseText);
  }
}

app.post('/api/flashcards', async (req, res) => {
  const { notes, count, images, image, mimeType, gradeLevel, academicStrand, difficulty, subjectMode } = req.body;

  try {
    const activeSubjectMode = String(subjectMode || 'general').toLowerCase();
    const parsedCount = Number.parseInt(count, 10);
    const requestedCount = Number.isInteger(parsedCount) && parsedCount > 0
      ? Math.min(parsedCount, 50)
      : 10;
    const requestedDifficulty = String(difficulty || 'medium').toLowerCase();
    const difficultyLevel = ['easy', 'medium', 'hard'].includes(requestedDifficulty)
      ? requestedDifficulty
      : 'medium';

    const difficultyGuidance = {
      easy: 'Focus on foundational facts, direct recall, and clear wording.',
      medium: 'Use a balanced mix of recall and understanding appropriate to the target grade.',
      hard: 'Focus on detailed understanding, application, and connections between concepts.'
    }[difficultyLevel];

    const difficultyCardMix = {
      easy: 'Favor Multiple Choice and True/False (about 40% each), with the remaining cards as Identification. Do not use Enumeration.',
      medium: 'Use Multiple Choice, True/False, and Identification in roughly equal shares. Do not force Enumeration into this level.',
      hard: 'Keep the deck varied: use Enumeration for about one-third of cards, and split the remaining cards as evenly as possible among Multiple Choice, True/False, and Identification.'
    }[difficultyLevel];

    const diversityGuidance = requestedCount >= 20
      ? 'This is a large deck. Assign one different fact, problem, or concept to each card without repeating formats.'
      : 'Give each card a distinct fact, problem, or concept.';

    let subjectSpecificInstructions = "";
    if (activeSubjectMode === 'math') {
      subjectSpecificInstructions = "SUBJECT FOCUS: MATHEMATICS / GEN MATH / CALCULUS / STATISTICS.\n" +
        "- Focus on step-by-step problem solving, formulas, mathematical theorems, variable identifications, and word problems.\n" +
        "- Ensure clean standard text formatting for equations (e.g., x^2 + 5x + 6 = 0).\n" +
        "- For True/False questions, test mathematical properties, statements, or identity validity.\n" +
        "- Include final evaluated numerical answers or step solutions in the 'answer' or 'explanation' fields.";
    } else if (activeSubjectMode === 'filipino') {
      subjectSpecificInstructions = "AI PERSONA: FILIPINO AI (Guro sa Wika at Panitikang Filipino).\n" +
        "- You are a specialized Filipino AI Teacher. Generate ALL questions, choices, answers, and explanations strictly in standard Tagalog/Filipino language.\n" +
        "- Focus on Balarila, Talasalitaan, Panitikan, Retorika, Pagbasa at Pagsusuri, and Noli Me Tangere / El Filibusterismo.\n" +
        "- STRICT TRUE/FALSE RULE: Place ONLY the statement inside 'question'. NEVER append 'Tama o Mali', 'Tama/Mali', choices, or explanations inside 'question'. Set 'answer' strictly to 'Tama' or 'Mali'. Place reasoning in 'explanation' in Tagalog.";
    } else {
      subjectSpecificInstructions = "SUBJECT FOCUS: GENERAL ACADEMIC SUBJECTS (STEM, ABM, HUMSS, TVL).";
    }

    let systemInstructions = "You are an expert academic reviewer AI. Generate " + requestedCount + " structured study flashcards when the source supports that many unique facts.\n" +
                              "Target Level: " + (gradeLevel || 'Senior High School') + "\n" +
                              "Target Track/Strand: " + (academicStrand || 'General') + "\n" +
                              subjectSpecificInstructions + "\n\n" +
                              "Target Difficulty: " + difficultyLevel + ". " + difficultyGuidance + "\n\n" +
                              "Card type mix for this difficulty: " + difficultyCardMix + "\n\n" +
                              "Coverage and variety: " + diversityGuidance + "\n\n" +
                              "CRITICAL FORMAT RULES:\n" +
                              "1. Follow the card type mix for the selected difficulty.\n" +
                              "2. For Multiple Choice, put the question and options A, B, C, and D in the \"question\" string on separate lines, make \"answer\" the correct option string, and include an \"explanation\" field explaining why that answer is correct.\n" +
                              "3. For Identification, make \"question\" a clear prompt, make \"answer\" the exact key term or concept (STRICTLY 1 TO 3 WORDS MAXIMUM), AND ALWAYS include an \"explanation\" field with a brief 1-2 sentence definition or context explaining what the term is.\n" +
                              "4. For Enumeration, put numbered items only in \"answer\". Never include answer items in \"question\".\n" +
                              "5. For True/False (or Tama/Mali): Put ONLY the statement in \"question\". Do NOT add options or explanations into \"question\". Make \"answer\" strictly \"True\" or \"False\" (or \"Tama\" or \"Mali\"), and add a concise \"explanation\" field for reasoning.\n" +
                              "6. You must respond with a pure, raw JSON object containing a single top-level array property called \"cards\". Each item must contain string properties \"question\" and \"answer\".";

    const messages = [
      { role: "system", content: systemInstructions }
    ];

    const inputImages = Array.isArray(images)
      ? images
      : image && mimeType ? [{ data: image, mimeType }] : [];

    const validImages = inputImages.filter(file => file && typeof file.data === 'string');

    const normalizedImages = validImages.map(file => {
      const cleanBase64 = file.data.replace(/^data:image\/\w+;base64,/, '');
      const type = file.mimeType || 'image/jpeg';
      return { data: cleanBase64, mimeType: type };
    });

    if (normalizedImages.length > 0) {
      const content = [
        { type: "text", text: "Analyze these study note images along with any text inputs provided: " + (notes || "") }
      ];
      normalizedImages.forEach(file => {
        content.push({
          type: "image_url",
          image_url: { url: `data:${file.mimeType};base64,${file.data}` }
        });
      });
      messages.push({ role: "user", content });
    } else {
      messages.push({
        role: "user",
        content: "Here is the raw text study material: " + (notes || "Generate default relevant track items.")
      });
    }

    const parsedData = await generateWithGroq(messages, activeSubjectMode, requestedCount >= 20 ? 0.65 : 0.5);
    res.json(parsedData);

  } catch (error) {
    console.error("Flashcard generation error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to process flashcard data via Groq." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running at http://localhost:" + PORT);
});