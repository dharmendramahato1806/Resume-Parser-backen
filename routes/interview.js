const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(pdf|txt|doc|docx)$/i)) cb(null, true);
    else cb(new Error('Only PDF, TXT, DOC, DOCX allowed.'));
  },
});

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

async function callAI(prompt, maxTokens = 1200, temperature = 0.7) {
  const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY missing in .env');

  const res = await fetch(GROQ_API, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' }
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Groq API error: ${data.error.message}`);
  return data.choices[0].message.content.trim();
}

function parseJSON(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('JSON Parse Error. Data:', text);
    throw err;
  }
}

// POST /api/interview/parse-resume
router.post('/parse-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.json({ text: '' });
    let text = '';
    if (req.file.originalname.endsWith('.pdf')) {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text;
    } else {
      text = req.file.buffer.toString('utf8');
    }
    res.json({ text: text.substring(0, 8000) });
  } catch (err) {
    console.error('parse-resume error:', err.message);
    res.status(500).json({ error: 'Failed to parse resume', text: '' });
  }
});

// POST /api/interview/analyze-resume
router.post('/analyze-resume', async (req, res) => {
  try {
    const { resumeText, role, level, interviewType } = req.body;
    
    if (!resumeText || resumeText.trim().length < 50) {
      return res.status(400).json({ error: 'Resume text is required and must be substantial.' });
    }

    const prompt = `You are a high-stakes interviewer at a top tech company. Analyze this resume for a ${level} ${role} position (${interviewType} interview).

RESUME CONTENT:
${resumeText.substring(0, 8000)}

Return ONLY a valid JSON object:
{
  "name": "full name found in resume",
  "summary": "precise 2-3 sentence technical profile",
  "skills": ["tech1", "tech2", "specific-lib1", "specific-lib2"],
  "projects": [
      {"name": "Project Name", "tech": ["stack used"], "description": "Short summary of what they did"}
  ],
  "experience": "Detailed total duration",
  "strengths": ["concrete strength 1", "concrete strength 2"],
  "gaps": ["specific technical or experience gap noticed in resume"],
  "firstQuestion": "A high-impact opening question directly referencing a specific project or achievement from the resume.",
  "interviewFocus": ["Deep-dive into X project", "Architecture of Y"],
  "questionPlan": ["Topic 1 from resume", "Specific tech challenge mentioned", "Behavioral aspect related to company X they worked at"]
}`;
    const text = await callAI(prompt);
    res.json(parseJSON(text));
  } catch (err) {
    console.error('analyze-resume error:', err.message);
    res.status(500).json({
      error: 'Failed to analyze resume',
      name: 'Candidate', 
      summary: `Candidate applying for ${req.body.role}.`,
      skills: ['Communication', 'Problem Solving'],
      projects: [],
      experience: req.body.level,
      strengths: ['Motivated'],
      gaps: ['Assessment required'],
      firstQuestion: `Can you walk me through your most significant achievement in your career so far?`,
      interviewFocus: ['Experience', 'Skills'],
      questionPlan: ['Introduction', 'Technical Skills', 'Behavioral']
    });
  }
});

// Unique fallback questions pool — indexed by question number to avoid any repetition
const FALLBACK_QUESTIONS = [
  { question: "Tell me about a time you had to learn something completely new under pressure.", type: "Behavioral", intent: "Adaptability" },
  { question: "Walk me through a challenging project you worked on — what was your specific role?", type: "Behavioral", intent: "Problem solving" },
  { question: "Describe a situation where you disagreed with a teammate. How did you handle it?", type: "Behavioral", intent: "Conflict resolution" },
  { question: "What's the most complex technical problem you've solved? How did you approach it?", type: "Technical", intent: "Critical thinking" },
  { question: "How do you prioritize tasks when you have multiple deadlines at the same time?", type: "Situational", intent: "Time management" },
  { question: "Can you describe a project where you had to collaborate across different teams?", type: "Behavioral", intent: "Collaboration" },
  { question: "Tell me about a time when a project didn't go as planned. What did you do?", type: "Behavioral", intent: "Resilience" },
  { question: "What motivates you the most in your day-to-day work?", type: "Behavioral", intent: "Motivation" },
  { question: "Describe a situation where you had to make a decision without complete information.", type: "Situational", intent: "Decision making" },
  { question: "What is one skill you wish you had developed earlier in your career?", type: "Behavioral", intent: "Self-awareness" },
];

// POST /api/interview/next-question
router.post('/next-question', async (req, res) => {
  try {
    const { conversationHistory, session, resumeProfile, questionCount, firstQuestion } = req.body;

    // Build a numbered list of EVERY question already asked (including the very first one from analyze-resume)
    const historyQuestions = (conversationHistory || []).map((h) => h.question);
    const allAskedQuestions = firstQuestion
      ? [firstQuestion, ...historyQuestions]
      : historyQuestions;

    const alreadyAsked = allAskedQuestions
      .map((q, i) => `${i + 1}. "${q}"`)
      .join('\n');

    const lastEntry = conversationHistory?.slice(-1)[0] || null;
    const lastQuestion = lastEntry?.question || null;
    const lastAnswer   = lastEntry?.answer   || null;

    const prompt = `You are conducting a REAL job interview for a ${session.level} ${session.role} position. Interview type: ${session.type}.

CANDIDATE RESUME PROFILE:
Name: ${resumeProfile.name}
Technical Skills: ${resumeProfile.skills.join(', ')}
Key Projects: ${JSON.stringify(resumeProfile.projects || [])}
Interview Strategy / Focus areas: ${resumeProfile.interviewFocus.join(', ')}
Pre-prepared Question Topics: ${resumeProfile.questionPlan.join(', ')}

QUESTIONS ALREADY ASKED — YOU MUST NOT REPEAT OR PARAPHRASE ANY OF THESE:
${alreadyAsked || 'None yet'}

${lastQuestion ? `LAST QUESTION ASKED:\n"${lastQuestion}"` : ''}
${lastAnswer   ? `CANDIDATE'S LAST ANSWER:\n"${lastAnswer}"` : ''}

YOUR TASK: Generate Question #${(allAskedQuestions.length + 1)} for a ${session.level} ${session.role}.

INTERVIEWER LOGIC:
1. QUESTION TYPES: 
   - ROLE-SPECIFIC: Concepts expected at the ${session.level} level for a ${session.role}.
   - CODING: Provide a small coding challenge (e.g., "Write a [Language] function to...", "Refactor this logic...", or "Find the bug in..."). Keep it concise.
   - RESUME-BASED: Deep-dive into their specific projects and tech stack.
2. HANDLING SKIPS: If they skip, pivot to a core foundational concept.
3. PERSONALIZATION: Always name-drop a project or specific tech from the resume if possible.

Return ONLY a valid JSON object:
{
  "question": "Your question or coding task here",
  "type": "Technical | Situational | Deep-dive | Follow-up | Coding",
  "intent": "assessing [specific logic/skill]"
}`;

    const text = await callAI(prompt, 500, 1.0);
    const parsed = parseJSON(text);

    // Safety check: if AI somehow repeated a question, pick a unique fallback
    const isDuplicate = allAskedQuestions.some(
      (q) => q.toLowerCase().trim() === parsed.question.toLowerCase().trim()
    );
    if (isDuplicate) {
      console.warn('AI returned duplicate question — using fallback');
      const fallbackIndex = allAskedQuestions.length % FALLBACK_QUESTIONS.length;
      return res.json(FALLBACK_QUESTIONS[fallbackIndex]);
    }

    res.json(parsed);
  } catch (err) {
    console.error('next-question error:', err.message);
    // Use a unique fallback based on total questions asked so far
    const { conversationHistory, firstQuestion } = req.body || {};
    const asked = (conversationHistory?.length || 0) + (firstQuestion ? 1 : 0);
    const fallbackIndex = asked % FALLBACK_QUESTIONS.length;
    res.json(FALLBACK_QUESTIONS[fallbackIndex]);
  }
});

// POST /api/interview/evaluate-answer
router.post('/evaluate-answer', async (req, res) => {
  try {
    const { question, answer, session } = req.body;
    const prompt = `You are a strict but fair interviewer evaluating a real interview answer for a ${session.level} ${session.role} role.

Question asked: "${question}"
Candidate's answer: "${answer}"

Evaluate HONESTLY based on:
- Relevance: Did they actually answer the question?
- Depth: Was the answer detailed or vague?
- Examples: Did they give concrete examples?
- Clarity: Was it well-structured?

Score strictly from 1-10:
- 9-10: Exceptional, very detailed with great examples
- 7-8: Good, answered well with some examples
- 5-6: Average, answered but too vague or missing examples
- 3-4: Weak, barely answered or off-topic
- 1-2: Very poor, irrelevant or no real answer

Return ONLY a valid JSON object:
{
  "score": 7,
  "quality": "strong | adequate | weak",
  "note": "One specific sentence about THIS answer — what was good or bad about it"
}`;
    const text = await callAI(prompt, 250, 0.9);
    res.json(parseJSON(text));
  } catch (err) {
    console.error('evaluate-answer error:', err.message);
    res.json({ score: 6, quality: 'adequate', note: 'Answer recorded.' });
  }
});

// POST /api/interview/final-verdict
router.post('/final-verdict', async (req, res) => {
  try {
    const { session, resumeProfile, conversationHistory } = req.body;
    const fullConvo = conversationHistory.map((h, i) =>
      `Q${i + 1} [${h.type}]: ${h.question}\nAnswer: ${h.answer}\nEval: ${h.eval?.note || 'N/A'} (Score: ${h.eval?.score ?? 'N/A'}/10)`
    ).join('\n\n');

    const prompt = `You are a senior hiring manager. Make a final hiring decision for this candidate.

Role: ${session.level} ${session.role} (${session.type} interview)
Candidate: ${resumeProfile.name}
Summary: ${resumeProfile.summary}
Technical Profile: ${resumeProfile.skills.join(', ')}

FULL INTERVIEW TRANSCRIPT:
${fullConvo}

Return ONLY a valid JSON object:
{
  "decision": "Selected",
  "overallScore": 75,
  "confidence": "High | Medium | Low",
  "headline": "One punchy verdict sentence",
  "whatWentWell": ["point1","point2","point3"],
  "whatWentPoorly": ["point1","point2"],
  "standoutMoment": "The single best or worst moment",
  "improvements": [
    {"area": "Area", "feedback": "Specific advice"},
    {"area": "Area", "feedback": "Specific advice"},
    {"area": "Area", "feedback": "Specific advice"}
  ],
  "nextSteps": "What should happen next",
  "scoreBreakdown": {
    "technicalKnowledge": 70,
    "communication": 80,
    "problemSolving": 65,
    "cultureFit": 75,
    "experience": 70
  }
}`;
    const text = await callAI(prompt, 1500, 0.7);
    res.json(parseJSON(text));
  } catch (err) {
    console.error('final-verdict error:', err.message);
    res.status(500).json({ error: 'Failed to generate verdict' });
  }
});

module.exports = router;
